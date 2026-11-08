import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as outboundMedia from "openclaw/plugin-sdk/outbound-media";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { extractToolPayload } from "openclaw/plugin-sdk/tool-payload";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { qaChannelPlugin } from "../api.js";
import type { QaBusInboundMessageInput, QaBusThread } from "./bus-client.js";
import * as qaBus from "./bus-client.js";
import { createQaInboundParams, runQaInbound } from "./inbound.test-harness.js";

type QaDispatchTurn = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];

const QA_GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0nQAAAAASUVORK5CYII=";
const mediaUrl = path.resolve("image.png");
const imageAttachment = {
  kind: "image",
  mimeType: "image/png",
  fileName: "image.png",
  contentBase64: QA_GENERATED_IMAGE_BASE64,
};
const actions = qaChannelPlugin.actions!;

function mediaRequest(cfg: Awaited<ReturnType<typeof busFixture>>["cfg"]) {
  return {
    cfg,
    to: "thread:qa-room/thread-1",
    accountId: "default",
    replyToId: "parent-1",
    text: "caption",
    mediaUrl,
    mediaLocalRoots: [process.cwd()],
    async mediaReadFile(filePath: string) {
      expect(filePath).toBe(mediaUrl);
      return Buffer.from(QA_GENERATED_IMAGE_BASE64, "base64");
    },
  };
}

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  } finally {
    resetPluginRuntimeStateForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

async function busFixture(options: { mediaMaxMb?: number; namedAccount?: boolean } = {}) {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
  const state = createQaBusState(),
    bus = await startQaBusServer({ state });
  const cfg = {
    channels: {
      "qa-channel": {
        baseUrl: bus.baseUrl,
        mediaMaxMb: options.mediaMaxMb,
        accounts: options.namedAccount
          ? { other: { baseUrl: bus.baseUrl, enabled: false } }
          : undefined,
      },
    },
  };
  stops.push(() => bus.stop());
  return {
    state,
    bus,
    cfg,
    async receive(text: string, overrides: Partial<QaBusInboundMessageInput> = {}, reply = false) {
      const params = createQaInboundParams({ message: { text, ...overrides } });
      params.account = qaChannelPlugin.config.resolveAccount(cfg, "default");
      params.config = cfg;
      params.message = state.addInboundMessage(params.message);
      let context: QaDispatchTurn["ctxPayload"] | undefined;
      await runQaInbound(async (turn) => {
        context = turn.ctxPayload;
        if (reply) {
          await turn.delivery.deliver({ text: "reply" }, { kind: "final" });
        }
      }, params);
      assert(context, "inbound message must dispatch");
      return context;
    },
  };
}

describe("qa-channel plugin", () => {
  it.each([
    ["group:qa-room", "agent:main:qa-channel:group:group:qa-room", undefined],
    ["channel:qa-room", "agent:main:qa-channel:channel:channel:qa-room", "thread-1"],
    ["dm:alice", "agent:main:main", undefined],
  ] as const)(
    "resolves %s with only recoverable thread context",
    async (target, baseSessionKey, threadId) => {
      const resolved = await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {},
        agentId: "main",
        accountId: "default",
        target,
        currentSessionKey: target.startsWith("group:")
          ? undefined
          : `${baseSessionKey}:thread:thread-1`,
      });
      expect(resolved).toMatchObject({
        sessionKey: threadId ? `${baseSessionKey}:thread:${threadId}` : baseSessionKey,
        baseSessionKey,
      });
      expect(resolved?.threadId).toBe(threadId);
      if (target.startsWith("group:")) {
        expect(resolved).toMatchObject({ chatType: "group", to: target });
      }
    },
  );

  it.each(["text", "media", "payload"] as const)(
    "delivers the %s adapter contract",
    async (kind) => {
      const { state, cfg } = await busFixture();
      const requestSpy = vi.spyOn(http, "request");
      const onPlatformSendDispatch = vi.fn(async () => {});
      const assertDirectAdapterHandoff = vi.fn();
      const request = mediaRequest(cfg);
      expect(qaChannelPlugin.capabilities.media).toBe(true);
      const result = await qaChannelPlugin.message!.send![kind]!({
        ...request,
        onPlatformSendDispatch,
        assertDirectAdapterHandoff,
        payload: { text: request.text, mediaUrl, mediaUrls: [mediaUrl], isError: true },
      });
      expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
      const finalFence = assertDirectAdapterHandoff.mock.invocationCallOrder.at(-1)!;
      expect(onPlatformSendDispatch.mock.invocationCallOrder[0]).toBeLessThan(finalFence);
      expect(finalFence).toBeLessThan(requestSpy.mock.invocationCallOrder[0]!);
      expect(result.receipt.parts[0]).toMatchObject({
        kind: kind === "text" ? "text" : "media",
        replyToId: "parent-1",
        threadId: "thread-1",
      });
      const expected = {
        id: result.messageId,
        text: request.text,
        threadId: "thread-1",
        replyToId: "parent-1",
        ...(kind === "payload" ? { isError: true } : {}),
      };
      expect(state.getSnapshot().messages).toMatchObject([expected]);
      if (kind !== "text") {
        expect(state.getSnapshot().messages[0]?.attachments).toMatchObject([imageAttachment]);
      }
    },
  );

  it.for(["aborted", "revoked"] as const)(
    "fences media sends after preparation: %s",
    async (authority, { signal }) => {
      const { state, cfg } = await busFixture();
      const request = vi.spyOn(http, "request");
      const mediaStarted = createDeferred<void>();
      const releaseMedia = createDeferred<void>();
      const abort = new AbortController();
      const revoked = new Error("QA send custody revoked");
      let current = true;
      const onPlatformSendDispatch = vi.fn(async () => {});
      const assertDirectAdapterHandoff = vi.fn(() => {
        if (!current) {
          throw revoked;
        }
      });
      const requestParams = mediaRequest(cfg);
      const sending = qaChannelPlugin.message!.send!.media!({
        ...requestParams,
        mediaReadFile: async (filePath) => {
          mediaStarted.resolve();
          await releaseMedia.promise;
          return requestParams.mediaReadFile(filePath);
        },
        signal: abort.signal,
        onPlatformSendDispatch,
        assertDirectAdapterHandoff,
      });
      const settled = sending.catch((error: unknown) => error);
      try {
        await withinTest(
          awaitGateBeforeSettlement(mediaStarted.promise, sending, "media read must start first"),
          signal,
        );
        expect(request).not.toHaveBeenCalled();
        expect(onPlatformSendDispatch).not.toHaveBeenCalled();
        expect(state.getSnapshot().messages).toEqual([]);
        if (authority === "aborted") {
          abort.abort(new Error("QA send cancelled during media preparation"));
        } else if (authority === "revoked") {
          current = false;
        }
        releaseMedia.resolve();
        const result = await withinTest(settled, signal);
        expect.soft(request).not.toHaveBeenCalled();
        expect.soft(state.getSnapshot().messages).toEqual([]);
        assert(result instanceof PlatformMessageNotDispatchedError);
        expect(result.cause).toBe(authority === "aborted" ? abort.signal.reason : revoked);
        if (authority === "aborted") {
          expect(onPlatformSendDispatch).not.toHaveBeenCalled();
        } else {
          expect(assertDirectAdapterHandoff).toHaveBeenCalled();
        }
      } finally {
        releaseMedia.resolve();
        abort.abort();
        await settled;
      }
    },
  );

  it.each(["inline", "remote"] as const)(
    "enforces fractional MiB $source caps and continues after oversized attachments",
    async (source) => {
      const mediaMaxMb = 0.3,
        capBytes = 314572;
      const originalFetch = globalThis.fetch;
      if (source === "remote") {
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.hostname === "93.184.216.34") {
              return new Response(Buffer.alloc(Number(url.pathname.slice(1)), 0x61), {
                headers: { "content-type": "text/plain" },
              });
            }
            return originalFetch(input, init);
          }),
        );
      }
      const harness = await busFixture({ mediaMaxMb });
      const inputs = [
        ["exact", capBytes],
        ["just-over", capBytes + 1],
        ["small", 512],
      ] as const;
      for (const [text, bytes] of inputs) {
        const image = source === "inline" && text === "small";
        const content = image
          ? Buffer.from(QA_GENERATED_IMAGE_BASE64, "base64")
          : Buffer.alloc(bytes, 0x61);
        const conversation = { id: "qa-room", kind: "group" as const, title: "QA Room" };
        const context = await harness.receive(
          image ? "@bert hello" : text,
          {
            ...(image ? { conversation } : {}),
            attachments: [
              {
                id: text,
                kind: image ? "image" : "file",
                mimeType: image ? "image/png" : "text/plain",
                fileName: image ? "image.png" : `${text}.txt`,
                ...(source === "inline"
                  ? { contentBase64: content.toString("base64") }
                  : { url: `https://93.184.216.34/${bytes}` }),
              },
            ],
          },
          image,
        );
        if (bytes > capBytes) {
          expect(context.media).toEqual([]);
          expect(context.BodyForAgent).toContain("attachment unavailable");
        } else {
          const media = context.media!;
          expect(media).toHaveLength(1);
          expect(await readFile(media[0]!.path!)).toEqual(content);
          if (image) {
            expect(media[0]?.contentType).toBe("image/png");
            expect(path.basename(media[0]?.path ?? "")).toMatch(/^image---[a-f0-9-]{36}\.png$/);
            expect(context).toMatchObject({
              ChatType: "group",
              From: "group:qa-room",
              To: "group:qa-room",
              SessionKey: "agent:main:qa-channel:group:group:qa-room",
              SenderId: "alice",
              GroupSubject: "QA Room",
              WasMentioned: true,
            });
            expect(
              harness.state
                .getSnapshot()
                .messages.filter((message) => message.direction === "outbound"),
            ).toMatchObject([{ conversation: { id: "qa-room", kind: "group" } }]);
            expect(
              qaChannelPlugin.messaging?.resolveSessionConversation?.({
                kind: "group",
                rawId: "group:qa-room",
              }),
            ).toMatchObject({
              id: "qa-room",
              baseConversationId: "qa-room",
              parentConversationCandidates: ["qa-room"],
            });
          }
        }
      }
    },
  );
});

describe("message action bus", () => {
  type ThreadResult = { thread: QaBusThread; target: string; threadId: string };
  const wrongConversation = "qa-channel message is not in the selected conversation";
  let state: ReturnType<typeof createQaBusState>;
  let cfg: Awaited<ReturnType<typeof busFixture>>["cfg"];
  beforeEach(async () => {
    ({ state, cfg } = await busFixture({ namedAccount: true }));
  });
  async function act(
    action: ChannelMessageActionName,
    params: Record<string, unknown>,
    accountId = "default",
  ) {
    return extractToolPayload(
      await actions.handleAction!({ channel: "qa-channel", action, cfg, accountId, params }),
    );
  }
  async function expectMessage(
    action: ChannelMessageActionName,
    params: Record<string, unknown>,
    message: unknown,
  ) {
    const result = (await act(action, params)) as { message: { id: string } };
    expect(result).toMatchObject({ message });
    if (action === "thread-reply") {
      expect(result).toMatchObject({
        receipt: {
          primaryPlatformMessageId: result.message.id,
          threadId: params.threadId,
          parts: [{ threadId: params.threadId }],
        },
      });
    }
    return result.message;
  }
  async function search(params: Record<string, unknown>, accountId = "default") {
    const result = (await act("search", { query: "needle", ...params }, accountId)) as {
      messages: Array<{ id: string }>;
    };
    return result.messages.map(({ id }) => id);
  }
  const add = (
    to: string,
    text: string,
    extra: Partial<Parameters<typeof state.addOutboundMessage>[0]> = {},
  ) => state.addOutboundMessage({ to, text, ...extra });
  async function rejectsMessageActions(binding: Record<string, unknown>, error: string) {
    for (const [action, params] of [
      ["read", {}],
      ["reactions", {}],
      ["react", { emoji: "eyes" }],
      ["edit", { message: "forbidden edit" }],
      ["delete", {}],
    ] as const) {
      await expect(act(action, { ...binding, ...params })).rejects.toThrow(error);
    }
  }

  it("describes message-action aliases", () => {
    expect(qaChannelPlugin.config.listAccountIds(cfg)).toEqual(["default", "other"]);
    expect(qaChannelPlugin.config.defaultAccountId?.(cfg)).toBe("default");
    expect(actions.messageActionTargetAliases?.edit).toEqual({
      aliases: ["messageId"],
      deliveryTargetAliases: [],
    });
    expect(actions.describeMessageTool?.({ cfg })?.schema).toHaveProperty("properties.title");
  });
  it.each([false, true])("preserves thread/edit fields (legacy=%s)", async (legacy) => {
    const { thread, target, threadId } = (await act("thread-create", {
      ...(legacy ? { channelId: "a/b" } : { target: "channel:a/b", to: "old", channelId: "old" }),
      ...(legacy ? { title: "Title" } : { threadName: "Title", title: "ignored" }),
    })) as ThreadResult;
    expect({ thread, target, threadId }).toMatchObject({
      thread: { id: expect.stringMatching(/^thread-/), conversationId: "a/b", title: "Title" },
      target: "channel:a/b",
      threadId: thread.id,
    });
    const before = state.getSnapshot();
    for (const [accountId, channelId] of [
      ["other", "a/b"],
      ["default", "else"],
    ]) {
      await expect(
        act("thread-reply", { channelId, threadId, text: "foreign" }, accountId),
      ).rejects.toThrow("qa-bus thread not found in selected account and conversation");
    }
    expect(state.getSnapshot()).toEqual(before);
    const outbound = await expectMessage(
      "thread-reply",
      {
        threadId,
        ...(legacy
          ? { channelId: "a/b", text: "reply" }
          : { target, channelId: "old", message: "reply", text: "ignored" }),
      },
      { conversation: { id: "a/b", kind: "channel" }, text: "reply", threadId },
    );
    const binding = { to: target, threadId, messageId: outbound.id };
    const edit = legacy ? { text: "edit" } : { text: "ignored", message: "edit" };
    await expectMessage("edit", { ...binding, ...edit }, { text: "edit" });
    await expectMessage("read", binding, { text: "edit" });
    expect(await search({ query: "edit", channelId: "a/b", threadId })).toContain(outbound.id);
  });
  it("rejects every message action after deletion", async () => {
    const deleted = add("channel:qa-room", "deleted");
    const binding = { to: "channel:qa-room", messageId: deleted.id };
    await act("delete", binding);
    await rejectsMessageActions(binding, "qa-channel message was deleted");
  });
  it("binds message actions and searches to account, conversation and thread", async () => {
    const root = add("channel:allowed", "needle allowed root");
    const foreign = add("channel:other", "needle foreign root");
    const thread = add("thread:allowed/thread-1", "needle allowed thread", {
      threadId: "thread-1",
    });
    const otherAccount = add("channel:allowed", "needle foreign account", { accountId: "other" });
    await rejectsMessageActions(
      { to: "channel:allowed", messageId: foreign.id },
      wrongConversation,
    );
    await expect(
      act("read", { to: "channel:allowed", messageId: root.id }, "other"),
    ).rejects.toThrow("qa-bus message not found");
    for (const [to, messageId] of [
      ["dm:allowed", root.id],
      ["channel:allowed", thread.id],
      ["thread:allowed/thread-2", thread.id],
    ]) {
      await expect(act("read", { to, messageId })).rejects.toThrow(wrongConversation);
    }
    await expect(
      act("read", { to: "thread:allowed/thread-1", messageId: thread.id }),
    ).resolves.toBeDefined();
    for (const [params, account, expected] of [
      [{ channelId: "allowed" }, "default", [root.id]],
      [{ channelId: "thread:allowed/thread-1" }, "default", [thread.id]],
      [{ channelId: "dm:allowed" }, "default", []],
      [{ channelId: "allowed" }, "other", [otherAccount.id]],
      [{}, "default", [root.id, foreign.id, thread.id]],
    ] as const) {
      await expect(search(params, account)).resolves.toEqual(expected);
    }
    await expect(search({ threadId: "thread-1" })).rejects.toThrow(
      "qa-channel search requires channelId when threadId is provided",
    );
    const unchanged = state.readMessage({ accountId: "default", messageId: foreign.id });
    expect(unchanged).toMatchObject({ text: "needle foreign root", reactions: [] });
    expect(unchanged.deleted).not.toBe(true);
  });
  it("routes advertised and versioned sends and rejects conflicting thread metadata", async () => {
    expect(
      actions.extractToolSend?.({
        args: { action: "send", target: "qa-room", message: "hello" },
      }),
    ).toEqual({ to: "channel:qa-room", threadId: undefined });
    await expectMessage(
      "send",
      { target: "thread:/v1/group/Room%2FOne/Topic%2FTwo", message: "hello" },
      { text: "hello", conversation: { id: "Room/One", kind: "group" }, threadId: "Topic/Two" },
    );
    await expect(
      act("send", { to: "thread:qa-room/thread-1", threadId: "thread-2", message: "conflicting" }),
    ).rejects.toThrow("qa-channel target conflicts with the explicit threadId");
    expect(state.getSnapshot().messages).toHaveLength(1);
  });
});

it("serializes preview deletion with media and final delivery", async () => {
  const { state, bus, cfg } = await busFixture();
  const deleting = createDeferred<void>(),
    acknowledged = createDeferred<void>();
  const deleteMessage = qaBus.deleteQaBusMessage;
  vi.spyOn(qaBus, "deleteQaBusMessage").mockImplementation(async (input) => {
    const result = await deleteMessage(input);
    deleting.resolve();
    await acknowledged.promise;
    return result;
  });
  const edit = vi.spyOn(qaBus, "editQaBusMessage");
  vi.spyOn(outboundMedia, "loadOutboundMediaFromUrl").mockResolvedValue({
    buffer: Buffer.from("attachment"),
    kind: "document",
    contentType: "text/plain",
    fileName: "answer.txt",
  });
  const params = createQaInboundParams();
  params.account.baseUrl = bus.baseUrl;
  params.config = cfg;
  params.message = state.addInboundMessage(params.message);
  await runQaInbound(async (turn) => {
    const args = { command: "pwd", apiToken: "secret-token" };
    expect(turn.replyOptions?.allowToolLifecycleWhenProgressHidden).toBe(true);
    await turn.replyOptions?.onPartialReply?.({ text: "preview" });
    await turn.replyOptions?.onToolStart?.({ phase: "start", name: "exec", args });
    await turn.replyOptions?.onToolStart?.({
      phase: "update",
      name: "exec",
      args: { command: "ignored" },
    });
    const media = turn.delivery.deliver({ mediaUrl: "/tmp/answer.txt" }, { kind: "block" });
    await deleting.promise;
    const settled = Promise.allSettled([
      media,
      turn.replyOptions?.onPartialReply?.({ text: "expanded preview" }),
      turn.delivery.deliver({ text: "final caption" }, { kind: "final" }),
    ]);
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(edit).not.toHaveBeenCalled();
    } finally {
      acknowledged.resolve();
      await settled;
    }
    expect((await settled).map(({ status }) => status)).toEqual(Array(3).fill("fulfilled"));
    expect(
      state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound" && !message.deleted),
    ).toMatchObject([
      { text: "", attachments: [{ contentBase64: Buffer.from("attachment").toString("base64") }] },
      { text: "final caption", toolCalls: [{ name: "exec", arguments: args }] },
    ]);
    expect(state.getSnapshot().messages.at(-1)?.toolCalls).toEqual([
      { name: "exec", arguments: args },
    ]);
  }, params);
});
