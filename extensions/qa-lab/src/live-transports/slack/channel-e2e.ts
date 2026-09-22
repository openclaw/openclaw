import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { QaChannelE2eDriver, QaChannelE2eMessage } from "../shared/channel-e2e.types.js";
import { createSlackE2eObservations, describeSlackFailure } from "./channel-e2e-observations.js";
import type { SlackNativeWrite } from "./slack-live.capture.js";
import type { SlackAuthIdentity, SlackQaWebClient } from "./slack-live.contracts.js";

const fileSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  mimetype: z.string().optional(),
  shares: z
    .record(z.string(), z.record(z.string(), z.array(z.object({ ts: z.string() }))))
    .optional(),
});
const uploadSchema = z.object({
  files: z.array(z.object({ files: z.array(fileSchema) })),
});

type Receipt = { message: QaChannelE2eMessage; deleted?: boolean };
type Evidence = {
  operation: string;
  outcome: "pending" | "api-accepted" | "stored" | "uncertain" | "failed";
  requestEventId?: number;
  channelId?: string;
  threadId?: string;
  emoji?: string;
  messageId?: string;
  fileIds?: string[];
  detail?: string;
};

export type SlackChannelE2eSession = {
  driver: QaChannelE2eDriver;
  cleanup: () => Promise<void>;
  artifactPath: string;
};

export function createSlackChannelE2e(params: {
  channelId: string;
  driverIdentity: SlackAuthIdentity;
  sutIdentity: SlackAuthIdentity;
  driverClient: SlackQaWebClient;
  sutClient: SlackQaWebClient;
  sutWriteClient: SlackQaWebClient;
  cleanupDriverClient: SlackQaWebClient;
  cleanupSutClient: SlackQaWebClient;
  assertActive: () => void;
  assertLease: () => void;
  signal?: AbortSignal;
  waitReady: () => Promise<void>;
  outputDir: string;
  scenarioId: string;
  readNativeWrites: () => Promise<SlackNativeWrite[]>;
}): SlackChannelE2eSession {
  const receipts = new Map<string, Receipt>();
  const files = new Map<string, "driver" | "sut">();
  const reactions = new Map<string, { messageId: string; emoji: string }>();
  const evidence: Evidence[] = [];
  const pending = new Set<Promise<unknown>>();
  let lastSentId: string | undefined;
  let closing = false;
  let artifactWrites = Promise.resolve();
  const artifactPath = path.join(
    params.outputDir,
    `${params.scenarioId.replace(/[^a-zA-Z0-9_-]/gu, "-")}-slack-e2e.json`,
  );

  const assertActive = () => {
    params.assertActive();
    params.signal?.throwIfAborted();
    if (closing) {
      throw new Error("Slack E2E fixture driver is stopped");
    }
  };
  const persist = () => {
    const snapshot = JSON.stringify(
      {
        evidence,
        ownedMessages: [...receipts.values()],
        ownedFileIds: [...files.keys()],
        ownedReactions: [...reactions.values()],
      },
      null,
      2,
    );
    artifactWrites = artifactWrites.then(async () => {
      await fs.mkdir(params.outputDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(artifactPath, snapshot, { mode: 0o600 });
    });
    return artifactWrites;
  };
  const { checked, ensureReady, assertScopes, readNative, doctor } = createSlackE2eObservations({
    channelId: params.channelId,
    driverIdentity: params.driverIdentity,
    sutIdentity: params.sutIdentity,
    driverClient: params.driverClient,
    sutClient: params.sutClient,
    assertActive,
    waitReady: params.waitReady,
  });
  const own = (messageId: string, threadId?: string) => {
    const receipt = receipts.get(messageId);
    if (!receipt || receipt.deleted || (threadId && receipt.message.threadId !== threadId)) {
      throw new Error("Slack mutation requires an exact, live message receipt owned by this run");
    }
    return receipt;
  };
  const threadRoot = (threadId?: string, replyToMessageId?: string) => {
    const id = threadId ?? replyToMessageId;
    if (!id) {
      return undefined;
    }
    const receipt = own(id);
    const root = receipt.message.threadId ?? receipt.message.id;
    if (
      threadId &&
      replyToMessageId &&
      (own(replyToMessageId).message.threadId ?? replyToMessageId) !== root
    ) {
      throw new Error("Slack reply target does not belong to the requested thread");
    }
    return root;
  };
  const mutation = async <T>(
    operation: string,
    actor: "driver" | "sut",
    scopes: readonly string[],
    action: (entry: Evidence) => Promise<T>,
  ): Promise<T> => {
    await ensureReady();
    assertScopes(actor, scopes);
    const entry: Evidence = { operation, outcome: "pending" };
    evidence.push(entry);
    const task = (async () => {
      let dispatched = false;
      try {
        await persist();
        assertActive();
        dispatched = true;
        const result = await action(entry);
        entry.outcome = "api-accepted";
        await persist();
        assertActive();
        return result;
      } catch (error) {
        if (entry.outcome === "pending") {
          entry.outcome = dispatched ? "uncertain" : "failed";
          entry.detail = dispatched
            ? describeSlackFailure(error)
            : "not dispatched: run stopped before native action";
        }
        await persist();
        assertActive();
        // oxlint-disable-next-line preserve-caught-error -- Slack SDK causes can contain credentials; only sanitized diagnostics may escape.
        throw new Error(`Slack ${operation}: ${entry.detail ?? describeSlackFailure(error)}`);
      }
    })();
    pending.add(task);
    try {
      return await task;
    } finally {
      pending.delete(task);
    }
  };
  const driver: QaChannelE2eDriver = {
    signal: params.signal,
    assertActive,
    async doctor() {
      const result = await doctor();
      evidence.push({ operation: "same-lease readiness", outcome: "stored" });
      await persist();
      assertActive();
      return result;
    },
    async send(input) {
      const root = threadRoot(input.threadId, input.replyToMessageId);
      return await mutation("chat.postMessage", "driver", ["chat:write"], async (entry) => {
        const text =
          input.mention === false ? input.text : `<@${params.sutIdentity.userId}> ${input.text}`;
        const response = await params.driverClient.chat.postMessage({
          channel: params.channelId,
          text,
          thread_ts: root,
          unfurl_links: false,
          unfurl_media: false,
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack Web API method, not browser postMessage; the destination is the leased channel.
        });
        if (!response.ts || (response.channel && response.channel !== params.channelId)) {
          throw new Error("Slack post did not return an exact leased-channel receipt");
        }
        const message: QaChannelE2eMessage = {
          id: response.ts,
          channelId: params.channelId,
          threadId: root,
          text,
          actor: "driver",
        };
        receipts.set(message.id, { message });
        lastSentId = message.id;
        entry.messageId = message.id;
        return message;
      });
    },
    async read(input) {
      await ensureReady();
      const messages = await readNative(input);
      evidence.push({ operation: "read", outcome: "stored", messageId: input?.messageId });
      await persist();
      assertActive();
      return messages;
    },
    async edit(input) {
      const receipt = own(input.messageId, input.threadId);
      return await mutation(
        "chat.update",
        receipt.message.actor === "driver" ? "driver" : "sut",
        ["chat:write"],
        async (entry) => {
          const client =
            receipt.message.actor === "driver" ? params.driverClient : params.sutWriteClient;
          await client.chat.update({
            channel: params.channelId,
            ts: input.messageId,
            text: input.text,
          });
          receipt.message = { ...receipt.message, text: input.text };
          entry.messageId = input.messageId;
          return receipt.message;
        },
      );
    },
    async delete(input) {
      const receipt = own(input.messageId, input.threadId);
      await mutation(
        "chat.delete",
        receipt.message.actor === "driver" ? "driver" : "sut",
        ["chat:write"],
        async (entry) => {
          const client =
            receipt.message.actor === "driver" ? params.driverClient : params.sutWriteClient;
          await client.chat.delete({ channel: params.channelId, ts: input.messageId });
          receipt.deleted = true;
          entry.messageId = input.messageId;
        },
      );
    },
    async react(input) {
      own(input.messageId, input.threadId);
      const emoji = input.emoji.replace(/^:|:$/gu, "");
      const key = `${input.messageId}:${emoji}`;
      if (input.remove && !reactions.has(key)) {
        throw new Error("Slack reaction removal requires this run's add receipt");
      }
      await mutation(
        input.remove ? "reactions.remove" : "reactions.add",
        "driver",
        ["reactions:read", "reactions:write"],
        async (entry) => {
          const args = { channel: params.channelId, timestamp: input.messageId, name: emoji };
          if (input.remove) {
            await params.driverClient.reactions.remove(args);
            reactions.delete(key);
          } else {
            await params.driverClient.reactions.add(args);
            reactions.set(key, { messageId: input.messageId, emoji });
          }
          entry.messageId = input.messageId;
        },
      );
      const result = await checked("reactions.get (requires reactions:read)", () =>
        params.driverClient.reactions.get({
          channel: params.channelId,
          timestamp: input.messageId,
        }),
      );
      const stored =
        result.message?.reactions?.some(
          (reaction) =>
            reaction.name === emoji && reaction.users?.includes(params.driverIdentity.userId),
        ) ?? false;
      if (stored === Boolean(input.remove)) {
        throw new Error("Slack reaction API acceptance did not match stored driver reaction state");
      }
      evidence.push({ operation: "reactions.get", outcome: "stored", messageId: input.messageId });
      await persist();
      assertActive();
    },
    async thread(input) {
      await ensureReady();
      if (input.messageId) {
        return { threadId: threadRoot(undefined, input.messageId)! };
      }
      const root = await driver.send({ text: input.text ?? input.name, mention: false });
      return { threadId: root.id };
    },
    async upload(input) {
      const root = threadRoot(input.threadId);
      const name = input.fileName ?? path.basename(input.path);
      await ensureReady();
      assertScopes("driver", ["files:read", "files:write"]);
      assertScopes("sut", ["files:read"]);
      const bytes = await fs.readFile(input.path);
      assertActive();
      const ids = await mutation(
        "files.uploadV2",
        "driver",
        ["files:read", "files:write"],
        async (entry) => {
          const response = uploadSchema.parse(
            await params.driverClient.files.uploadV2({
              ...(root
                ? { channel_id: params.channelId, thread_ts: root }
                : { channel_id: params.channelId }),
              file: bytes,
              filename: name,
              initial_comment:
                input.mention === false
                  ? (input.text ?? name)
                  : `<@${params.sutIdentity.userId}> ${input.text ?? name}`,
            }),
          );
          const uploadedFileIds = response.files.flatMap((file) =>
            file.files.map((item) => item.id),
          );
          if (uploadedFileIds.length !== 1) {
            throw new Error("Slack upload did not return one exact file receipt");
          }
          for (const id of uploadedFileIds) {
            files.set(id, "driver");
          }
          entry.fileIds = uploadedFileIds;
          return uploadedFileIds;
        },
      );
      const info = await checked("files.info (requires files:read)", () =>
        params.driverClient.files.info({ file: ids[0]! }),
      );
      const file = fileSchema.parse(info.file);
      const shares = Object.values(file.shares ?? {}).flatMap(
        (channels) => channels[params.channelId] ?? [],
      );
      const sharedId = shares.at(-1)?.ts;
      if (file.id !== ids[0] || !sharedId) {
        throw new Error("Slack uploaded file lacks a stored share receipt in the leased channel");
      }
      const message = (await driver.read({ messageId: sharedId, threadId: root }))[0];
      if (
        !message ||
        message.actor !== "driver" ||
        !message.attachments?.some((item) => item.id === file.id && item.name === name)
      ) {
        throw new Error("Slack stored upload did not retain the exact driver/file/name identity");
      }
      receipts.set(message.id, { message });
      lastSentId = message.id;
      await persist();
      assertActive();
      return message;
    },
    async waitForReply(input) {
      await ensureReady();
      const afterId = input.afterMessageId ?? lastSentId;
      const root = threadRoot(input.threadId, afterId);
      if (!afterId || !root) {
        throw new Error("Slack reply wait requires this run's ingress receipt and thread");
      }
      const deadline = Date.now() + (input.timeoutMs ?? 60_000);
      while (true) {
        const messages = await readNative({ threadId: root, after: afterId, limit: 1000 });
        if (!input.threadId && !own(afterId).message.threadId && input.textIncludes) {
          const writes = await checked("captured SUT writes", params.readNativeWrites);
          const acceptedIds = new Set(
            writes
              .filter(
                (write) =>
                  write.evidence === "api-accepted" &&
                  write.method === "chat.postMessage" &&
                  write.channelId === params.channelId,
              )
              .map((write) => write.messageId),
          );
          const topLevel = await readNative({ after: afterId, limit: 1000 });
          messages.push(
            ...topLevel.filter((message) => !message.threadId && acceptedIds.has(message.id)),
          );
        }
        const reply = messages.find(
          (message) =>
            message.actor === "sut" &&
            Number(message.id) > Number(afterId) &&
            (message.threadId === root ||
              (!input.threadId && !message.threadId && Boolean(input.textIncludes))) &&
            (!input.textIncludes || message.text.includes(input.textIncludes)),
        );
        if (reply) {
          receipts.set(reply.id, { message: reply });
          evidence.push({
            operation: "waitForReply",
            outcome: "stored",
            messageId: reply.id,
            fileIds: reply.attachments?.map((file) => file.id),
          });
          await persist();
          assertActive();
          return reply;
        }
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for a correlated stored Slack SUT reply");
        }
        await sleep(Math.min(1000, deadline - Date.now()), undefined, { signal: params.signal });
        assertActive();
      }
    },
  };

  const cleanup = async () => {
    closing = true;
    await Promise.allSettled(pending);
    const failures: string[] = [];
    const clean = async (
      operation: string,
      messageId: string | undefined,
      action: () => Promise<unknown>,
      outcome: "api-accepted" | "stored" = "api-accepted",
    ) => {
      const entry: Evidence = { operation, messageId, outcome: "pending" };
      evidence.push(entry);
      try {
        params.assertLease();
        await action();
        params.assertLease();
        entry.outcome = outcome;
      } catch (error) {
        entry.outcome = "failed";
        entry.detail = describeSlackFailure(error);
        failures.push(`${operation}: ${entry.detail}`);
      }
      await persist();
    };
    // Capture belongs to the Gateway proxy. Only its writes to our exact thread roots are owned.
    await clean(
      "capture owned SUT receipts",
      undefined,
      async () => {
        const writes = await params.readNativeWrites();
        params.assertLease();
        for (const write of writes) {
          evidence.push({
            operation: `Gateway ${write.method}`,
            outcome: write.evidence,
            requestEventId: write.requestEventId,
            channelId: write.channelId,
            threadId: write.threadId,
            emoji: write.emoji,
            messageId: write.messageId,
            fileIds: write.fileIds,
            detail: write.reason,
          });
          if (write.evidence !== "api-accepted") {
            continue;
          }
          if (
            write.method === "chat.postMessage" &&
            write.channelId === params.channelId &&
            write.messageId &&
            write.threadId &&
            receipts.get(write.threadId)?.message.actor === "driver" &&
            !receipts.has(write.messageId)
          ) {
            receipts.set(write.messageId, {
              message: {
                id: write.messageId,
                channelId: params.channelId,
                threadId: write.threadId,
                text: "",
                actor: "sut",
              },
            });
          }
          if (
            write.method === "files.completeUploadExternal" &&
            write.channelId === params.channelId
          ) {
            for (const fileId of write.fileIds ?? []) {
              if (
                (write.threadId && receipts.get(write.threadId)?.message.actor === "driver") ||
                [...receipts.values()].some(
                  ({ message }) =>
                    message.actor === "sut" &&
                    message.attachments?.some((file) => file.id === fileId),
                )
              ) {
                files.set(fileId, "sut");
              }
            }
          }
          if (write.method === "files.delete") {
            for (const fileId of write.fileIds ?? []) {
              if (files.get(fileId) === "sut") {
                files.delete(fileId);
              }
            }
          }
        }
      },
      "stored",
    );
    for (const [key, reaction] of reactions) {
      if (receipts.get(reaction.messageId)?.deleted) {
        reactions.delete(key);
        continue;
      }
      await clean("cleanup reactions.remove", reaction.messageId, async () => {
        await params.cleanupDriverClient.reactions.remove({
          channel: params.channelId,
          timestamp: reaction.messageId,
          name: reaction.emoji,
        });
        reactions.delete(key);
      });
    }
    for (const [id, actor] of files) {
      await clean("cleanup files.delete", undefined, async () => {
        const client = actor === "driver" ? params.cleanupDriverClient : params.cleanupSutClient;
        await client.files.delete({ file: id });
        files.delete(id);
      });
    }
    for (const receipt of [...receipts.values()].toReversed()) {
      if (receipt.deleted) {
        continue;
      }
      await clean("cleanup chat.delete", receipt.message.id, async () => {
        const client =
          receipt.message.actor === "driver" ? params.cleanupDriverClient : params.cleanupSutClient;
        try {
          await client.chat.delete({ channel: params.channelId, ts: receipt.message.id });
        } catch (error) {
          // files.delete may already remove the file-share message; absence is safe only for an owned receipt.
          if (describeSlackFailure(error) !== "message_not_found") {
            throw error;
          }
        }
        receipt.deleted = true;
      });
    }
    await persist();
    const uncertain = evidence.filter(
      (entry) => entry.outcome === "uncertain" || entry.outcome === "pending",
    );
    if (failures.length || uncertain.length) {
      throw new Error(
        `Slack E2E cleanup incomplete: ${failures.length} cleanup failures; ${uncertain.length} uncertain operations. Preserve private evidence: ${artifactPath}`,
      );
    }
  };
  return { driver, cleanup, artifactPath };
}
