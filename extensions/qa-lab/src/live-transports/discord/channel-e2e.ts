import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DiscordApiError, requestDiscord } from "@openclaw/discord/api.js";
import type { QaChannelE2eDriver, QaChannelE2eMessage } from "../shared/channel-e2e.types.js";
import {
  inspectDiscordE2eReadiness,
  type DiscordE2eChannel,
  type DiscordE2eRuntimeEnv,
} from "./channel-e2e-doctor.js";
import { createDiscordE2eRecorder, type DiscordE2eNativeMessage } from "./channel-e2e-recorder.js";

type OwnedMessage = { id: string; channelId: string; actor: "driver" | "sut" };
export type DiscordChannelE2eSession = {
  driver: QaChannelE2eDriver;
  assertHealthy(): void;
  stop(): Promise<void>;
  cleanup(): Promise<void>;
};

export function createDiscordChannelE2eSession(params: {
  runtimeEnv: DiscordE2eRuntimeEnv;
  driverId: string;
  sutId: string;
  outputDir: string;
  scenarioId: string;
  signal?: AbortSignal;
  assertLeaseActive: () => void;
  assertActive: () => void;
  waitForSutReady: () => Promise<void>;
}): DiscordChannelE2eSession {
  params.assertActive();
  params.signal?.throwIfAborted();
  const env = params.runtimeEnv;
  const evidenceDir = path.join(params.outputDir, `discord-e2e-${randomUUID()}`);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const record = (row: Record<string, unknown>) =>
    appendFileSync(
      path.join(evidenceDir, "events.ndjson"),
      `${JSON.stringify({ at: new Date().toISOString(), scenarioId: params.scenarioId, ...row })}\n`,
      { mode: 0o600 },
    );
  const owned = new Map<string, OwnedMessage>();
  const threads = new Set<string>();
  const reactions = new Map<string, { messageId: string; channelId: string; emoji: string }>();
  const unresolved = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const stopController = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, stopController.signal])
    : stopController.signal;
  let stopped = false;
  let lastTrigger: string | undefined;
  let ready = false;
  let canDeleteThreads = false;
  const recorder = createDiscordE2eRecorder({
    token: env.driverBotToken,
    guildId: env.guildId,
    channelId: env.channelId,
    driverId: params.driverId,
    sutId: params.sutId,
    assertActive: params.assertLeaseActive,
    record,
  });
  const assertActive = () => {
    params.assertActive();
    signal.throwIfAborted();
    if (stopped) {
      throw new Error("Discord E2E session is stopped");
    }
    recorder.assertHealthy();
  };
  function channel(threadId?: string) {
    assertActive();
    if (threadId && !threads.has(threadId)) {
      throw new Error("Discord E2E refuses a thread not created by this scenario");
    }
    return threadId ?? env.channelId;
  }
  function requireOwned(messageId: string, channelId: string, driverOnly = false) {
    const message = owned.get(messageId);
    if (!message || message.channelId !== channelId || (driverOnly && message.actor !== "driver")) {
      throw new Error("Discord E2E refuses mutation of an unowned message");
    }
    return message;
  }
  function normalize(message: DiscordE2eNativeMessage): QaChannelE2eMessage {
    return {
      id: message.id,
      channelId: message.channel_id,
      ...(message.channel_id !== env.channelId ? { threadId: message.channel_id } : {}),
      text: message.content ?? "",
      actor:
        message.author?.id === params.driverId
          ? "driver"
          : message.author?.id === params.sutId
            ? "sut"
            : "other",
      attachments: message.attachments?.map((attachment) => ({
        id: attachment.id,
        name: attachment.filename,
        contentType: attachment.content_type,
        url: attachment.url,
      })),
    };
  }
  function remember(message: DiscordE2eNativeMessage, channelId: string) {
    if (
      !/^\d{17,20}$/u.test(message.id) ||
      message.channel_id !== channelId ||
      message.author?.id !== params.driverId
    ) {
      throw new Error("Discord write returned an unexpected identity; ownership is ambiguous");
    }
    owned.set(message.id, { id: message.id, channelId, actor: "driver" });
    recorder.trackDriverMessage(message.id);
    lastTrigger = message.id;
  }
  async function request<T>(
    route: string,
    options: {
      method?: string;
      body?: unknown;
      accept?: (value: T) => void;
      cleanup?: boolean;
      token?: string;
    } = {},
  ): Promise<T> {
    const check = options.cleanup ? params.assertLeaseActive : assertActive;
    check();
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const operationId = randomUUID();
    const writes = method !== "GET";
    if (writes) {
      unresolved.add(operationId);
      record({ source: "native-api", phase: "intent", operationId, method, route });
    }
    const operation = requestDiscord<T>(route, options.token ?? env.driverBotToken, {
      method,
      body: options.body,
      signal: options.cleanup ? undefined : signal,
      timeoutMs: 15_000,
      retry: { attempts: 1 },
    });
    pending.add(operation);
    try {
      const result = await operation;
      if (writes) {
        record({ source: "native-api", phase: "response", operationId, method, route, result });
      }
      // Capture receipts before the post-await authority check so cancellation cannot erase ownership.
      options.accept?.(result);
      if (writes) {
        record({ source: "native-api", phase: "receipt", operationId, method, route });
        unresolved.delete(operationId);
      }
      check();
      return result;
    } catch (error) {
      if (writes) {
        // A definite Discord rejection is not an uncertain write. Transport/5xx failures are.
        if (error instanceof DiscordApiError && error.status >= 400 && error.status < 500) {
          unresolved.delete(operationId);
        }
        record({
          source: "native-api",
          phase: "failure",
          operationId,
          method,
          route,
          status: error instanceof DiscordApiError ? error.status : undefined,
          ambiguous: unresolved.has(operationId),
        });
      }
      throw error;
    } finally {
      pending.delete(operation);
    }
  }
  async function assertReady() {
    assertActive();
    if (!ready) {
      const result = await driver.doctor();
      assertActive();
      if (!result.ok) {
        throw new Error(
          `Discord E2E readiness failed: ${result.checks
            .filter((check) => !check.ok)
            .map((check) => `${check.name}: ${check.detail}`)
            .join("; ")}`,
        );
      }
    }
  }
  function messageBody(text: string, mention?: boolean) {
    return {
      content: mention
        ? text.includes("@openclaw")
          ? text.replaceAll("@openclaw", `<@${params.sutId}>`)
          : `<@${params.sutId}> ${text}`
        : text,
      allowed_mentions: { parse: [], users: mention ? [params.sutId] : [], replied_user: false },
    };
  }

  const driver: QaChannelE2eDriver = {
    signal,
    assertActive,
    async doctor() {
      const inspection = await inspectDiscordE2eReadiness({
        runtimeEnv: env,
        driverId: params.driverId,
        sutId: params.sutId,
        request,
        assertActive,
        connectRecorder: () => recorder.connect(),
        waitForSutReady: params.waitForSutReady,
      });
      assertActive();
      canDeleteThreads = inspection.canDeleteThreads;
      ready = inspection.result.ok;
      record({ source: "doctor", ...inspection.result });
      return inspection.result;
    },
    async send(input) {
      await assertReady();
      const channelId = channel(input.threadId);
      if (input.replyToMessageId) {
        requireOwned(input.replyToMessageId, channelId);
      }
      const message = await request<DiscordE2eNativeMessage>(`/channels/${channelId}/messages`, {
        body: {
          ...messageBody(input.text, input.mention),
          ...(input.replyToMessageId
            ? {
                message_reference: { message_id: input.replyToMessageId, fail_if_not_exists: true },
              }
            : {}),
        },
        accept: (value) => remember(value, channelId),
      });
      return normalize(message);
    },
    async upload(input) {
      await assertReady();
      const channelId = channel(input.threadId);
      const bytes = await readFile(input.path, { signal });
      assertActive();
      const fileName = path.basename(input.fileName ?? input.path);
      const form = new FormData();
      form.set(
        "payload_json",
        JSON.stringify({
          ...messageBody(input.text ?? "", input.mention),
          attachments: [{ id: 0, filename: fileName }],
        }),
      );
      form.set("files[0]", new Blob([bytes]), fileName);
      const message = await request<DiscordE2eNativeMessage>(`/channels/${channelId}/messages`, {
        body: form,
        accept: (value) => remember(value, channelId),
      });
      return normalize(message);
    },
    async read(input = {}) {
      await assertReady();
      const channelId = channel(input.threadId);
      for (const id of [input.messageId, input.before, input.after]) {
        if (id !== undefined && !/^\d{17,20}$/u.test(id)) {
          throw new Error("Discord E2E requires snowflake message cursors");
        }
      }
      if (input.before && input.after) {
        throw new Error("Discord E2E read accepts before or after, not both");
      }
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Discord E2E read limit must be an integer from 1 to 100");
      }
      if (input.messageId) {
        return [
          normalize(
            await request<DiscordE2eNativeMessage>(
              `/channels/${channelId}/messages/${input.messageId}`,
            ),
          ),
        ];
      }
      const query = new URLSearchParams({
        limit: String(limit),
        ...(input.before ? { before: input.before } : {}),
        ...(input.after ? { after: input.after } : {}),
      });
      return (
        await request<DiscordE2eNativeMessage[]>(`/channels/${channelId}/messages?${query}`)
      ).map(normalize);
    },
    async edit(input) {
      await assertReady();
      const channelId = channel(input.threadId);
      requireOwned(input.messageId, channelId, true);
      return normalize(
        await request<DiscordE2eNativeMessage>(
          `/channels/${channelId}/messages/${input.messageId}`,
          {
            method: "PATCH",
            body: messageBody(input.text),
          },
        ),
      );
    },
    async delete(input) {
      await assertReady();
      const channelId = channel(input.threadId);
      requireOwned(input.messageId, channelId, true);
      await request<void>(`/channels/${channelId}/messages/${input.messageId}`, {
        method: "DELETE",
        accept: () => {
          owned.delete(input.messageId);
        },
      });
    },
    async react(input) {
      await assertReady();
      const channelId = channel(input.threadId);
      requireOwned(input.messageId, channelId);
      const key = `${channelId}/${input.messageId}/${input.emoji}`;
      if (input.remove && !reactions.has(key)) {
        throw new Error("Discord E2E refuses removal of a reaction it did not add");
      }
      await request<void>(
        `/channels/${channelId}/messages/${input.messageId}/reactions/${encodeURIComponent(input.emoji)}/@me`,
        {
          method: input.remove ? "DELETE" : "PUT",
          accept: () => {
            if (input.remove) {
              reactions.delete(key);
            } else {
              reactions.set(key, { channelId, messageId: input.messageId, emoji: input.emoji });
            }
          },
        },
      );
    },
    async thread(input) {
      await assertReady();
      const anchor = input.messageId ?? (await driver.send({ text: input.text ?? input.name })).id;
      assertActive();
      requireOwned(anchor, env.channelId, true);
      const result = await request<DiscordE2eChannel>(
        `/channels/${env.channelId}/messages/${anchor}/threads`,
        {
          body: { name: input.name, auto_archive_duration: 60 },
          accept: (value) => {
            if (!/^\d{17,20}$/u.test(value.id) || value.parent_id !== env.channelId) {
              throw new Error(
                "Discord thread receipt does not match the leased parent; ownership is ambiguous",
              );
            }
            threads.add(value.id);
            recorder.trackThread(value.id);
          },
        },
      );
      return { threadId: result.id };
    },
    async waitForReply(input) {
      await assertReady();
      const channelId = channel(input.threadId);
      const trigger = input.afterMessageId ?? lastTrigger;
      if (!trigger) {
        throw new Error("Discord reply wait requires an owned driver message cursor");
      }
      requireOwned(trigger, channelId, true);
      const timeoutMs = input.timeoutMs ?? 60_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Discord reply timeout must be positive");
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        assertActive();
        for (const message of recorder.messages()) {
          if (
            message.deleted ||
            message.channel_id !== channelId ||
            message.author?.id !== params.sutId ||
            BigInt(message.id) <= BigInt(trigger)
          ) {
            continue;
          }
          const replyTo = message.message_reference?.message_id;
          if (replyTo && replyTo !== trigger) {
            continue;
          }
          // A bare newer SUT message is insufficient: require a native reference or a caller's unique marker.
          if (!replyTo && !input.textIncludes) {
            continue;
          }
          if (input.textIncludes && !(message.content ?? "").includes(input.textIncludes)) {
            continue;
          }
          owned.set(message.id, { id: message.id, channelId, actor: "sut" });
          recorder.correlateReply(message.id, trigger);
          assertActive();
          return normalize(message);
        }
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal });
        assertActive();
      }
      throw new Error(
        "Discord correlated SUT reply timed out; inspect private recorder and Gateway/provider evidence",
      );
    },
  };
  return {
    driver,
    assertHealthy: assertActive,
    async stop() {
      stopped = true;
      stopController.abort();
      await Promise.allSettled(pending);
    },
    async cleanup() {
      // Called only by the adapter's post-Gateway-stop phase, while the lease is still renewed.
      recorder.close();
      const failures: unknown[] = [];
      for (const message of recorder.messages()) {
        const trigger = message.message_reference?.message_id;
        const source = trigger ? owned.get(trigger) : undefined;
        if (
          !message.deleted &&
          message.author?.id === params.sutId &&
          source?.actor === "driver" &&
          source.channelId === message.channel_id &&
          BigInt(message.id) > BigInt(source.id)
        ) {
          owned.set(message.id, { id: message.id, channelId: message.channel_id, actor: "sut" });
        }
      }
      const remove = async (route: string, method: string, body?: unknown, token?: string) => {
        try {
          await request(route, { method, body, token, cleanup: true });
          return "removed";
        } catch (error) {
          if (error instanceof DiscordApiError && error.status === 404) {
            return "already-absent";
          }
          failures.push(error);
          return "failed";
        }
      };
      for (const reaction of reactions.values()) {
        await remove(
          `/channels/${reaction.channelId}/messages/${reaction.messageId}/reactions/${encodeURIComponent(reaction.emoji)}/@me`,
          "DELETE",
        );
      }
      // Remove thread messages before parent anchors, then dispose only receipt-owned threads.
      const messages = [...owned.values()].toSorted(
        (a, b) => Number(a.channelId === env.channelId) - Number(b.channelId === env.channelId),
      );
      for (const message of messages) {
        await remove(
          `/channels/${message.channelId}/messages/${message.id}`,
          "DELETE",
          undefined,
          message.actor === "sut" ? env.sutBotToken : env.driverBotToken,
        );
      }
      const threadDispositions: Array<{ threadId: string; action: string; result: string }> = [];
      for (const threadId of threads) {
        const result = canDeleteThreads
          ? await remove(`/channels/${threadId}`, "DELETE")
          : await remove(`/channels/${threadId}`, "PATCH", { archived: true });
        threadDispositions.push({
          threadId,
          action: canDeleteThreads ? "delete" : "archive",
          result,
        });
      }
      record({
        source: "cleanup",
        ok: failures.length === 0 && unresolved.size === 0,
        unresolvedOperations: [...unresolved],
        failureCount: failures.length,
        threadDispositions,
      });
      if (unresolved.size) {
        failures.push(
          new Error(
            `Discord native writes have ambiguous ownership; preserve ${evidenceDir} for manual reconciliation; do not resend or sweep`,
          ),
        );
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          `Discord owned cleanup incomplete; inspect ${evidenceDir}`,
        );
      }
      // A clean fixture teardown cannot turn an incomplete observation into a passing run.
      recorder.assertHealthy();
    },
  };
}
