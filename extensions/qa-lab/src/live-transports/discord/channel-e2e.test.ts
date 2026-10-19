import type { EventEmitter } from "node:events";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
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
        this.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
      }
      receive(packet: unknown) {
        queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(packet))));
      }
      send(value: string) {
        const packet: unknown = JSON.parse(value);
        if (packet && typeof packet === "object" && "op" in packet && packet.op === 2) {
          const user = { id: "423456789012345678", bot: true };
          this.receive({ op: 0, s: 1, t: "READY", d: { user } });
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
const messagePath = (id?: string, channel = channelId) =>
  `/channels/${channel}/messages${id ? `/${id}` : ""}`;
const mutation = (method: string, id?: string, actor = "driver") => ({
  method,
  route: messagePath(id),
  token: `Bot ${actor}-token`,
});
function nativeMessage(id: string, content: string, extra: Partial<DiscordE2eNativeMessage> = {}) {
  return { id, content, channel_id: channelId, author: { id: sutId }, ...extra };
}
function expectEvidence(rows: Record<string, unknown>[], expected: Record<string, unknown>[]) {
  expect(rows).toEqual(expect.arrayContaining(expected.map((row) => expect.objectContaining(row))));
}
const rejects = (promise: Promise<unknown>, error?: string) =>
  expect(promise).rejects.toThrow(error);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let currentSession: DiscordChannelE2eSession | undefined;
afterEach(async () => {
  await currentSession?.stop();
  await currentSession?.cleanup().catch(() => {});
  currentSession = undefined;
  vi.useRealTimers();
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
          .object({ content: z.string() })
          .parse(JSON.parse(z.string().parse(init?.body)));
        const message = nativeMessage(String(nextId++), body.content, {
          channel_id: target,
          author: { id: driverId },
        });
        messages.set(message.id, message);
        return Response.json(message);
      }
      if (method === "DELETE" && id) {
        messages.delete(id);
        return new Response(null, { status: 204 });
      }
      if (method === "GET" && id) {
        return Response.json(messages.get(id));
      }
    }
    if (/^\/channels\/\d+$/u.test(route)) {
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
  currentSession = session;
  return {
    session,
    driver: session.driver,
    controller,
    messages,
    mutations,
    fetcher,
    async finish(error?: string) {
      await session.stop();
      await (error ? rejects(session.cleanup(), error) : session.cleanup());
    },
    loseLease: () => {
      leaseActive = false;
    },
    emit(kind: string, data: Record<string, unknown>) {
      const d = { channel_id: channelId, guild_id: guildId, ...data };
      const packet = { op: 0, s: ++sequence, t: kind, d };
      socketHarness.current!.emit("message", Buffer.from(JSON.stringify(packet)));
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

it("reading an unrelated message does not grant mutation or cleanup ownership", async () => {
  const f = fixture();
  const unrelated = "623456789012345678";
  f.messages.set(unrelated, nativeMessage(unrelated, "preexisting", { author: { id: driverId } }));
  await f.driver.doctor();
  await f.driver.read({ messageId: unrelated });
  const d = f.driver;
  await rejects(d.edit({ messageId: unrelated, text: "changed" }), "unowned");
  await rejects(d.delete({ messageId: unrelated }), "unowned");
  await rejects(d.react({ messageId: unrelated, emoji: "fixture" }), "unowned");
  await rejects(d.send({ threadId: unrelated, text: "foreign thread" }), "not created");
  const own = await f.driver.send({ text: "owned" });
  await f.finish();
  expect(f.messages.has(own.id)).toBe(false);
  expect(f.messages.get(unrelated)?.content).toBe("preexisting");
  expect(f.mutations).toEqual([mutation("POST"), mutation("DELETE", own.id)]);
});

it("reports missing native permissions as failures instead of skipping lifecycle operations", async () => {
  const f = fixture({ missingPermissions: true });
  const result = await f.driver.doctor();
  expect(result).toMatchObject({
    ok: false,
    capabilities: { unavailable: [{ reason: expect.stringContaining("missing ViewChannel") }] },
  });
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
  const rejected = rejects(sending, "scenario cancelled");
  await started.promise;
  f.controller.abort(new Error("scenario cancelled"));
  f.messages.set(id, nativeMessage(id, "racing abort", { author: { id: driverId } }));
  response.resolve(Response.json(f.messages.get(id)));
  await rejected;
  await rejects(f.driver.send({ text: "after cancellation" }), "scenario cancelled");
  await f.finish();
  expect(f.messages.has(id)).toBe(false);
  expectEvidence(await f.evidence(), [{ source: "cleanup", ok: true }]);
});

it("retains a correlated SUT reply delivered after fixture admission stops", async () => {
  const f = fixture();
  const trigger = await f.driver.send({ text: "owned trigger", mention: true });
  await f.session.stop();
  await rejects(f.driver.send({ text: "too late" }));
  const id = "623456789012345678";
  const lateReply = nativeMessage(id, "shutdown reply", {
    message_reference: { message_id: trigger.id },
  });
  f.messages.set(id, lateReply);
  f.emit("MESSAGE_CREATE", lateReply);
  await f.session.cleanup();
  expect(f.messages.has(id)).toBe(false);
  expect(f.mutations).toContainEqual(mutation("DELETE", id, "sut"));
});

it("cleans marker-correlated replies after a recorder failure without claiming unrelated messages", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const marker = "OWNED_REPLY_MARKER";
  const trigger = await f.driver.send({ text: `reply with ${marker}`, mention: true });
  const thread = await f.driver.thread({ name: "owned thread", messageId: trigger.id });
  const waiting = f.driver.waitForReply({ afterMessageId: trigger.id, textIncludes: marker });
  const rejected = rejects(waiting, "closed (1006)");
  await vi.advanceTimersByTimeAsync(0);
  const reply = nativeMessage("623456789012345678", marker);
  const unrelated: DiscordE2eNativeMessage[] = [
    { ...reply, id: "523456789012345677" },
    { ...reply, id: "623456789012345679", content: "another conversation" },
    { ...reply, id: "623456789012345680", author: { id: driverId } },
    { ...reply, id: "623456789012345681", channel_id: thread.threadId },
    {
      ...reply,
      id: "623456789012345682",
      message_reference: { message_id: "923456789012345678" },
    },
  ];
  for (const message of [reply, ...unrelated]) {
    f.messages.set(message.id, message);
    f.emit("MESSAGE_CREATE", message);
  }
  socketHarness.current!.emit("close", 1006);
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  await f.finish("closed (1006)");

  expect([f.messages.has(trigger.id), f.messages.has(reply.id)]).toEqual([false, false]);
  expect(unrelated.every((message) => f.messages.has(message.id))).toBe(true);
  const deletions = f.mutations.filter((row) => row.method === "DELETE");
  expect(deletions).toEqual(
    expect.arrayContaining([mutation("DELETE", trigger.id), mutation("DELETE", reply.id, "sut")]),
  );
  expect(deletions).toHaveLength(2);
  expectEvidence(await f.evidence(), [
    { source: "correlation", messageId: reply.id, triggerMessageId: trigger.id },
    { source: "recorder", continuous: false },
  ]);
});

it("never retries an uncertain write or sweeps the channel to conceal its missing receipt", async () => {
  const f = fixture();
  await f.driver.doctor();
  f.fetcher.mockRejectedValueOnce(new Error("connection lost after Discord accepted the request"));
  const before = f.fetcher.mock.calls.length;
  await rejects(f.driver.send({ text: "uncertain" }), "connection lost");
  expect(f.fetcher.mock.calls.length - before).toBe(1);
  await f.finish("cleanup incomplete");
  expect(f.mutations).toEqual([]);
  expect((await f.evidence()).find((row) => row.source === "cleanup")).toMatchObject({
    ok: false,
  });
});

it("matches SUT identity, cursor and reference while preserving authorless revisions and reaction actors", async () => {
  const f = fixture();
  const trigger = await f.driver.send({ text: "reply with UNIQUE_MARKER", mention: true });
  const emitReply = (id: string, extra: Partial<DiscordE2eNativeMessage> = {}) =>
    f.emit("MESSAGE_CREATE", nativeMessage(id, "UNIQUE_MARKER", extra));
  emitReply("523456789012345677");
  emitReply("523456789012345679", { author: { id: driverId } });
  emitReply("523456789012345680", { channel_id: "923456789012345678" });
  emitReply("523456789012345681", { message_reference: { message_id: "923456789012345678" } });
  const sutReplyId = "523456789012345682";
  emitReply(sutReplyId, {
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
  await f.finish("closed");
  const evidence = await f.evidence();
  const sutMessage = { actor: "sut", messageId: sutReplyId };
  const updated = { ...sutMessage, kind: "MESSAGE_UPDATE", triggerMessageId: trigger.id };
  expectEvidence(evidence, [
    { ...updated, text: "UNIQUE_MARKER" },
    { ...sutMessage, kind: "MESSAGE_DELETE", deletedText: "UNIQUE_MARKER" },
    {
      kind: "MESSAGE_REACTION_ADD",
      actor: "sut",
      isDrivenMessage: true,
      messageId: trigger.id,
    },
    { kind: "TYPING_START", actor: "sut" },
    { source: "recorder", continuous: false },
  ]);
  expect(evidence.some((row) => row.messageId === "523456789012345680")).toBe(false);
  expect(f.mutations.filter((row) => row.method === "DELETE").map((row) => row.route)).toEqual([
    messagePath(trigger.id),
    messagePath(sutReplyId),
  ]);
});

it.each([false, true])(
  "reports thread archival versus deletion using existing permissions (manage threads: %s)",
  async (manageThreads) => {
    const f = fixture({ manageThreads });
    const root = await f.driver.send({ text: "thread root" });
    const thread = await f.driver.thread({ name: "qa-owned", messageId: root.id });
    const child = await f.driver.send({ text: "thread child", threadId: thread.threadId });
    await f.finish();
    const cleanup = (await f.evidence()).find((row) => row.source === "cleanup");
    const disposition = {
      threadId: thread.threadId,
      action: manageThreads ? "delete" : "archive",
      result: "removed",
    };
    expect(cleanup).toMatchObject({ ok: true, threadDispositions: [disposition] });
    expect(
      f.mutations
        .filter((row) => row.method === "DELETE")
        .slice(0, 2)
        .map((row) => row.route),
    ).toEqual([messagePath(child.id, thread.threadId), messagePath(root.id)]);
  },
);

it("stops native effects and preserves owned cleanup failures after lease loss", async () => {
  const f = fixture();
  const message = await f.driver.send({ text: "owned but expired" });
  const writesBefore = f.mutations.length;
  f.loseLease();
  await rejects(f.driver.edit({ messageId: message.id, text: "forbidden" }), "lease expired");
  await f.finish("cleanup incomplete");
  expect(f.mutations).toHaveLength(writesBefore);
  expect(f.messages.has(message.id)).toBe(true);
});
