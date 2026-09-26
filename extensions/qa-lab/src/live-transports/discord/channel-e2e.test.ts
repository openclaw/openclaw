import type { EventEmitter } from "node:events";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DiscordE2eNativeMessage } from "./channel-e2e-recorder.js";
import { createDiscordChannelE2eSession, type DiscordChannelE2eSession } from "./channel-e2e.js";

const socketHarness = vi.hoisted(() => ({
  current: undefined as (EventEmitter & { terminate(): void }) | undefined,
}));
vi.mock("ws", async () => {
  // Vitest hoists this factory before static imports; the fake socket needs EventEmitter here.
  const { EventEmitter } = await import("node:events");
  return {
    default: class Socket extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        super();
        socketHarness.current = this;
        queueMicrotask(() =>
          this.emit(
            "message",
            Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
          ),
        );
      }
      send(value: string) {
        const packet: unknown = JSON.parse(value);
        if (packet && typeof packet === "object" && "op" in packet && packet.op === 2) {
          queueMicrotask(() =>
            this.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  op: 0,
                  s: 1,
                  t: "READY",
                  d: { user: { id: "423456789012345678", bot: true } },
                }),
              ),
            ),
          );
        }
      }
      terminate() {
        this.readyState = 3;
      }
    },
  };
});
const guildId = "123456789012345678";
const channelId = "223456789012345678";
const sutId = "323456789012345678";
const driverId = "423456789012345678";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessions: DiscordChannelE2eSession[] = [];
afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map(async (session) => {
      await session.stop();
      await session.cleanup().catch(() => {});
    }),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(options: { manageThreads?: boolean; missingPermissions?: boolean } = {}) {
  const outputDir = tempDirs.make("discord-e2e-");
  const controller = new AbortController();
  let leaseActive = true;
  let nextId = 523456789012345678n;
  let sequence = 1;
  const messages = new Map<string, DiscordE2eNativeMessage>();
  const mutations: Array<{ method: string; route: string; token: string | null }> = [];
  const permissions = [6, 10, 11, 15, 16, 35, 38, ...(options.manageThreads ? [34] : [])]
    .reduce((bits, bit) => bits | (1n << BigInt(bit)), 0n)
    .toString();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = url.pathname.replace("/api/v10", "");
    const method = init?.method ?? "GET";
    const token = new Headers(init?.headers).get("Authorization");
    if (method !== "GET") {
      mutations.push({ method, route, token });
    }
    if (route === "/users/@me") {
      return Response.json({ id: token === "Bot sut-token" ? sutId : driverId, bot: true });
    }
    if (route === `/guilds/${guildId}/roles`) {
      return Response.json([
        { id: guildId, permissions: options.missingPermissions ? "0" : permissions },
      ]);
    }
    if (route.startsWith(`/guilds/${guildId}/members/`)) {
      return Response.json({ roles: [] });
    }
    if (route === `/channels/${channelId}`) {
      return Response.json({ id: channelId, guild_id: guildId, type: 0 });
    }
    const thread = route.match(/^\/channels\/(\d+)\/messages\/(\d+)\/threads$/u);
    if (thread && method === "POST") {
      return Response.json({ id: thread[2], parent_id: channelId, guild_id: guildId, type: 11 });
    }
    const messageRoute = route.match(/^\/channels\/(\d+)\/messages(?:\/(\d+))?$/u);
    if (messageRoute) {
      const target = messageRoute[1]!;
      const id = messageRoute[2];
      if (method === "POST") {
        const body = z
          .object({
            content: z.string(),
            message_reference: z.object({ message_id: z.string() }).optional(),
          })
          .parse(JSON.parse(z.string().parse(init?.body)));
        const message = {
          id: String(nextId++),
          channel_id: target,
          author: { id: driverId },
          content: body.content,
          message_reference: body.message_reference,
        };
        messages.set(message.id, message);
        return Response.json(message);
      }
      if (method === "DELETE" && id) {
        messages.delete(id);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH" && id) {
        const message = messages.get(id)!;
        message.content = z
          .object({ content: z.string() })
          .parse(JSON.parse(z.string().parse(init?.body))).content;
        return Response.json(message);
      }
      if (id) {
        return messages.has(id)
          ? Response.json(messages.get(id))
          : Response.json({ message: "Unknown message" }, { status: 404 });
      }
      return Response.json(
        [...messages.values()].filter((message) => message.channel_id === target),
      );
    }
    if (route.includes("/reactions/") || /^\/channels\/\d+$/u.test(route)) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fixture route ${method} ${route}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const assertLeaseActive = () => {
    if (!leaseActive) {
      throw new Error("lease expired");
    }
  };
  const session = createDiscordChannelE2eSession({
    runtimeEnv: {
      guildId,
      channelId,
      sutApplicationId: sutId,
      driverBotToken: "driver-token",
      sutBotToken: "sut-token",
    },
    driverId,
    sutId,
    outputDir,
    scenarioId: "discord-regression",
    signal: controller.signal,
    assertLeaseActive,
    assertActive: assertLeaseActive,
    waitForSutReady: async () => {},
  });
  sessions.push(session);
  return {
    session,
    driver: session.driver,
    controller,
    messages,
    mutations,
    fetcher,
    loseLease: () => {
      leaseActive = false;
    },
    emit(kind: string, data: Record<string, unknown>) {
      socketHarness.current!.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            op: 0,
            s: ++sequence,
            t: kind,
            d: { channel_id: channelId, guild_id: guildId, ...data },
          }),
        ),
      );
    },
    async evidence() {
      const [directory] = await readdir(outputDir);
      const file = path.join(outputDir, directory!, "events.ndjson");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      return (await readFile(file, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

describe("Discord agent E2E authority and evidence", () => {
  it("reading an unrelated message does not grant mutation or cleanup ownership", async () => {
    const f = fixture();
    const unrelated = "623456789012345678";
    f.messages.set(unrelated, {
      id: unrelated,
      channel_id: channelId,
      content: "preexisting",
      author: { id: driverId },
    });
    await f.driver.doctor();
    await f.driver.read({ messageId: unrelated });
    await expect(f.driver.edit({ messageId: unrelated, text: "changed" })).rejects.toThrow(
      "unowned",
    );
    await expect(f.driver.delete({ messageId: unrelated })).rejects.toThrow("unowned");
    await expect(f.driver.react({ messageId: unrelated, emoji: "fixture" })).rejects.toThrow(
      "unowned",
    );
    await expect(f.driver.send({ threadId: unrelated, text: "foreign thread" })).rejects.toThrow(
      "not created",
    );
    const own = await f.driver.send({ text: "owned" });
    await f.session.stop();
    await f.session.cleanup();
    expect(f.messages.has(own.id)).toBe(false);
    expect(f.messages.get(unrelated)?.content).toBe("preexisting");
    expect(f.mutations).toEqual([
      { method: "POST", route: `/channels/${channelId}/messages`, token: "Bot driver-token" },
      {
        method: "DELETE",
        route: `/channels/${channelId}/messages/${own.id}`,
        token: "Bot driver-token",
      },
    ]);
  });

  it("reports missing native permissions as failures instead of skipping lifecycle operations", async () => {
    const f = fixture({ missingPermissions: true });
    const result = await f.driver.doctor();
    expect(result.ok).toBe(false);
    expect(result.capabilities.unavailable).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("missing ViewChannel") }),
    ]);
    expect(f.mutations).toEqual([]);
  });

  it("retains an acknowledged write racing cancellation and cleans it with still-held lease authority", async () => {
    const f = fixture();
    await f.driver.doctor();
    const started = createDeferred<void>();
    const response = createDeferred<Response>();
    const id = "523456789012345679";
    f.fetcher.mockImplementationOnce(async () => {
      started.resolve();
      return await response.promise;
    });
    const sending = f.driver.send({ text: "racing abort" });
    const rejected = expect(sending).rejects.toThrow("scenario cancelled");
    await started.promise;
    f.controller.abort(new Error("scenario cancelled"));
    f.messages.set(id, {
      id,
      channel_id: channelId,
      content: "racing abort",
      author: { id: driverId },
    });
    response.resolve(Response.json(f.messages.get(id)));
    await rejected;
    await expect(f.driver.send({ text: "after cancellation" })).rejects.toThrow(
      "scenario cancelled",
    );
    await f.session.stop();
    await f.session.cleanup();
    expect(f.messages.has(id)).toBe(false);
    expect((await f.evidence()).some((row) => row.source === "cleanup" && row.ok === true)).toBe(
      true,
    );
  });

  it("retains a correlated SUT reply delivered after fixture admission stops", async () => {
    const f = fixture();
    const trigger = await f.driver.send({ text: "owned trigger", mention: true });
    await f.session.stop();
    await expect(f.driver.send({ text: "too late" })).rejects.toThrow();
    const id = "623456789012345678";
    const lateReply = {
      id,
      channel_id: channelId,
      author: { id: sutId },
      content: "shutdown reply",
      message_reference: { message_id: trigger.id },
    };
    f.messages.set(id, lateReply);
    f.emit("MESSAGE_CREATE", lateReply);
    await f.session.cleanup();
    expect(f.messages.has(id)).toBe(false);
    expect(f.mutations).toContainEqual({
      method: "DELETE",
      route: `/channels/${channelId}/messages/${id}`,
      token: "Bot sut-token",
    });
  });

  it("never retries an uncertain write or sweeps the channel to conceal its missing receipt", async () => {
    const f = fixture();
    await f.driver.doctor();
    f.fetcher.mockRejectedValueOnce(
      new Error("connection lost after Discord accepted the request"),
    );
    const before = f.fetcher.mock.calls.length;
    await expect(f.driver.send({ text: "uncertain" })).rejects.toThrow("connection lost");
    expect(f.fetcher.mock.calls.length - before).toBe(1);
    await f.session.stop();
    await expect(f.session.cleanup()).rejects.toThrow("cleanup incomplete");
    expect(f.mutations).toEqual([]);
    expect((await f.evidence()).find((row) => row.source === "cleanup")).toMatchObject({
      ok: false,
    });
  });

  it("matches SUT identity, cursor and reference while preserving authorless revisions and reaction actors", async () => {
    const f = fixture();
    const trigger = await f.driver.send({ text: "reply with UNIQUE_MARKER", mention: true });
    f.emit("MESSAGE_CREATE", {
      id: "523456789012345677",
      author: { id: sutId },
      content: "UNIQUE_MARKER",
    });
    f.emit("MESSAGE_CREATE", {
      id: "523456789012345679",
      author: { id: driverId },
      content: "UNIQUE_MARKER",
    });
    f.emit("MESSAGE_CREATE", {
      id: "523456789012345680",
      channel_id: "923456789012345678",
      author: { id: sutId },
      content: "UNIQUE_MARKER",
    });
    f.emit("MESSAGE_CREATE", {
      id: "523456789012345681",
      author: { id: sutId },
      content: "UNIQUE_MARKER",
      message_reference: { message_id: "923456789012345678" },
    });
    const sutReplyId = "523456789012345682";
    f.emit("MESSAGE_CREATE", {
      id: sutReplyId,
      author: { id: sutId },
      content: "draft",
      message_reference: { message_id: trigger.id },
    });
    f.emit("MESSAGE_UPDATE", { id: sutReplyId, content: "UNIQUE_MARKER" });
    const reply = await f.driver.waitForReply({
      afterMessageId: trigger.id,
      textIncludes: "UNIQUE_MARKER",
      timeoutMs: 100,
    });
    expect(reply.id).toBe(sutReplyId);
    f.emit("MESSAGE_REACTION_ADD", {
      message_id: trigger.id,
      user_id: sutId,
      emoji: { name: "fixture", id: "823456789012345678" },
    });
    f.emit("TYPING_START", { user_id: sutId });
    f.emit("MESSAGE_DELETE", { id: sutReplyId });
    socketHarness.current!.emit("close", 4004);
    expect(() => f.driver.assertActive()).toThrow("closed");
    await f.session.stop();
    await expect(f.session.cleanup()).rejects.toThrow("closed");
    const evidence = await f.evidence();
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "MESSAGE_UPDATE",
          actor: "sut",
          messageId: sutReplyId,
          triggerMessageId: trigger.id,
          text: "UNIQUE_MARKER",
        }),
        expect.objectContaining({
          kind: "MESSAGE_DELETE",
          actor: "sut",
          messageId: sutReplyId,
          deletedText: "UNIQUE_MARKER",
        }),
        expect.objectContaining({
          kind: "MESSAGE_REACTION_ADD",
          actor: "sut",
          isDrivenMessage: true,
          messageId: trigger.id,
        }),
        expect.objectContaining({ kind: "TYPING_START", actor: "sut" }),
        expect.objectContaining({ source: "recorder", continuous: false }),
      ]),
    );
    expect(evidence.some((row) => row.messageId === "523456789012345680")).toBe(false);
    expect(f.mutations.filter((row) => row.method === "DELETE").map((row) => row.route)).toEqual([
      `/channels/${channelId}/messages/${trigger.id}`,
      `/channels/${channelId}/messages/${sutReplyId}`,
    ]);
  });

  it.each([false, true])(
    "reports thread archival versus deletion using existing permissions (manage threads: %s)",
    async (manageThreads) => {
      const f = fixture({ manageThreads });
      const root = await f.driver.send({ text: "thread root" });
      const thread = await f.driver.thread({ name: "qa-owned", messageId: root.id });
      const child = await f.driver.send({ text: "thread child", threadId: thread.threadId });
      await f.session.stop();
      await f.session.cleanup();
      const cleanup = (await f.evidence()).find((row) => row.source === "cleanup");
      expect(cleanup).toMatchObject({
        ok: true,
        threadDispositions: [
          {
            threadId: thread.threadId,
            action: manageThreads ? "delete" : "archive",
            result: "removed",
          },
        ],
      });
      expect(
        f.mutations
          .filter((row) => row.method === "DELETE")
          .slice(0, 2)
          .map((row) => row.route),
      ).toEqual([
        `/channels/${thread.threadId}/messages/${child.id}`,
        `/channels/${channelId}/messages/${root.id}`,
      ]);
    },
  );

  it("stops native effects and preserves owned cleanup failures after lease loss", async () => {
    const f = fixture();
    const message = await f.driver.send({ text: "owned but expired" });
    const writesBefore = f.mutations.length;
    f.loseLease();
    await expect(f.driver.edit({ messageId: message.id, text: "forbidden" })).rejects.toThrow(
      "lease expired",
    );
    await f.session.stop();
    await expect(f.session.cleanup()).rejects.toThrow("cleanup incomplete");
    expect(f.mutations).toHaveLength(writesBefore);
    expect(f.messages.has(message.id)).toBe(true);
  });
});
