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
import { listQaChannelAccountIds, resolveDefaultQaChannelAccountId } from "./accounts.js";
import type { QaBusInboundMessageInput, QaBusThread } from "./bus-client.js";
import * as qaBus from "./bus-client.js";
import { createQaInboundParams, runQaInbound } from "./inbound.test-harness.js";

type QaDispatchTurn = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];

const QA_GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0nQAAAAASUVORK5CYII=";

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

describe("QA channel account resolution", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        "qa-channel": { baseUrl: "http://qa", accounts: { work: { enabled: false } } },
      },
    };

    expect(listQaChannelAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultQaChannelAccountId(cfg)).toBe("default");
  });

  it("declares edit message IDs as current-conversation resource references", () => {
    expect(qaChannelPlugin.actions?.messageActionTargetAliases?.edit).toEqual({
      aliases: ["messageId"],
      deliveryTargetAliases: [],
    });
  });
});

async function busFixture(
  options: {
    mediaMaxMb?: number;
    namedAccount?: boolean;
  } = {},
) {
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
        accounts: options.namedAccount ? { other: { baseUrl: bus.baseUrl } } : undefined,
      },
    },
  };
  stops.push(() => bus.stop());
  return {
    state,
    bus,
    cfg,
    async receive(text: string, overrides: Partial<QaBusInboundMessageInput> = {}) {
      const params = createQaInboundParams({ message: { text, ...overrides } });
      params.account = qaChannelPlugin.config.resolveAccount(cfg, "default");
      params.config = cfg;
      params.message = state.addInboundMessage(params.message);
      let context: QaDispatchTurn["ctxPayload"] | undefined;
      await runQaInbound(async (turn) => {
        context = turn.ctxPayload;
        await turn.delivery.deliver(
          { text: `qa-echo: ${turn.ctxPayload.BodyForAgent ?? turn.ctxPayload.Body ?? ""}` },
          { kind: "final" },
        );
      }, params);
      assert(context, "inbound message must dispatch");
      const message = await state.waitFor({
        kind: "message-text",
        direction: "outbound",
        textIncludes: `qa-echo: ${text}`,
        timeoutMs: 15_000,
      });
      return { context, message };
    },
  };
}

function route(target: string, extra: { threadId?: string; currentSessionKey?: string } = {}) {
  return qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
    cfg: {},
    agentId: "main",
    accountId: "default",
    target,
    ...extra,
  });
}

describe("qa-channel plugin", () => {
  it("normalizes explicit group targets for session group policy lookup", () => {
    const resolved = qaChannelPlugin.messaging?.resolveSessionConversation?.({
      kind: "group",
      rawId: "group:qa-room",
    });

    expect(resolved).toMatchObject({
      id: "qa-room",
      baseConversationId: "qa-room",
      parentConversationCandidates: ["qa-room"],
    });
  });

  it.each([
    ["group:qa-room", "agent:main:qa-channel:group:group:qa-room", undefined],
    ["channel:qa-room", "agent:main:qa-channel:channel:channel:qa-room", "thread-1"],
    ["dm:alice", "agent:main:main", undefined],
  ] as const)(
    "resolves %s with only recoverable thread context",
    async (target, baseSessionKey, threadId) => {
      const resolved = await route(target, {
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
      const onPlatformSendDispatch = vi.fn(async () => {});
      const assertDirectAdapterHandoff = vi.fn();
      const mediaUrl = path.join(process.cwd(), "qa-channel-generated-capability.png");
      const text = "generated image";
      expect(qaChannelPlugin.capabilities.media).toBe(true);
      const result = await qaChannelPlugin.message!.send![kind]!({
        cfg,
        to: "thread:qa-room/thread-1",
        accountId: "default",
        replyToId: "parent-1",
        text,
        mediaUrl,
        mediaLocalRoots: [process.cwd()],
        onPlatformSendDispatch,
        assertDirectAdapterHandoff,
        mediaReadFile: async (filePath: string) => {
          expect(filePath).toBe(mediaUrl);
          return Buffer.from(QA_GENERATED_IMAGE_BASE64, "base64");
        },
        payload: { text, mediaUrl, mediaUrls: [mediaUrl], isError: true },
      });
      expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
      expect(assertDirectAdapterHandoff).toHaveBeenCalled();
      expect(result.receipt.parts[0]).toMatchObject({
        kind: kind === "text" ? "text" : "media",
        replyToId: "parent-1",
        threadId: "thread-1",
      });
      const expected = {
        id: result.messageId,
        text,
        threadId: "thread-1",
        replyToId: "parent-1",
        ...(kind === "payload" ? { isError: true } : {}),
      };
      expect(state.getSnapshot().messages).toMatchObject([expected]);
      if (kind !== "text") {
        expect(state.getSnapshot().messages[0]?.attachments).toMatchObject([
          {
            kind: "image",
            mimeType: "image/png",
            fileName: "qa-channel-generated-capability.png",
            contentBase64: QA_GENERATED_IMAGE_BASE64,
          },
        ]);
      }
    },
  );

  it.for(["aborted", "revoked", "current"] as const)(
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
      const mediaPath = path.join(process.cwd(), "qa-channel-held-media.png");
      const sending = qaChannelPlugin.message!.send!.media!({
        cfg,
        to: "channel:qa-room",
        accountId: "default",
        text: "one atomic caption",
        mediaUrl: mediaPath,
        mediaLocalRoots: [process.cwd()],
        mediaReadFile: async (filePath) => {
          expect(filePath).toBe(mediaPath);
          mediaStarted.resolve();
          await releaseMedia.promise;
          return Buffer.from(QA_GENERATED_IMAGE_BASE64, "base64");
        },
        signal: abort.signal,
        onPlatformSendDispatch,
        assertDirectAdapterHandoff,
      });
      const settled = sending.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            mediaStarted.promise,
            sending,
            "media send settled before reading the attachment",
          ),
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
        const expectedSends = authority === "current" ? 1 : 0;
        expect.soft(request).toHaveBeenCalledTimes(expectedSends);
        expect.soft(state.getSnapshot().messages).toHaveLength(expectedSends);
        if (authority !== "current") {
          assert(result instanceof PlatformMessageNotDispatchedError);
          expect(result.cause).toBe(authority === "aborted" ? abort.signal.reason : revoked);
          if (authority === "aborted") {
            expect(onPlatformSendDispatch).not.toHaveBeenCalled();
          } else {
            expect(assertDirectAdapterHandoff).toHaveBeenCalled();
          }
          return;
        }
        await expect(sending).resolves.toBeDefined();
        expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
        const finalFence = assertDirectAdapterHandoff.mock.invocationCallOrder.at(-1)!;
        expect(onPlatformSendDispatch.mock.invocationCallOrder[0]).toBeLessThan(finalFence);
        expect(finalFence).toBeLessThan(request.mock.invocationCallOrder[0]!);
        expect(state.getSnapshot().messages[0]).toMatchObject({
          text: "one atomic caption",
          attachments: [{ contentBase64: QA_GENERATED_IMAGE_BASE64, mimeType: "image/png" }],
        });
      } finally {
        releaseMedia.resolve();
        abort.abort();
        await settled;
      }
    },
  );

  it(
    "surfaces shared group traffic with the room target as From",
    { timeout: 20_000 },
    async () => {
      const harness = await busFixture();

      const { context, message } = await harness.receive("@bert hello", {
        conversation: { id: "qa-room", kind: "group", title: "QA Room" },
      });

      expect(context).toMatchObject({
        ChatType: "group",
        From: "group:qa-room",
        To: "group:qa-room",
        SessionKey: "agent:main:qa-channel:group:group:qa-room",
        SenderId: "alice",
        GroupSubject: "QA Room",
        WasMentioned: true,
      });
      expect(message).toMatchObject({ conversation: { id: "qa-room", kind: "group" } });
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
        const { context } = await harness.receive(text, {
          attachments: [
            {
              id: text,
              kind: "file",
              mimeType: "text/plain",
              fileName: `${text}.txt`,
              ...(source === "inline"
                ? { contentBase64: Buffer.alloc(bytes, 0x61).toString("base64") }
                : { url: `https://93.184.216.34/${bytes}` }),
            },
          ],
        });
        if (bytes > capBytes) {
          expect(context.media).toEqual([]);
          expect(context.BodyForAgent).toContain("attachment unavailable");
        } else {
          const media = context.media!;
          expect(media).toHaveLength(1);
          expect(await readFile(media[0]!.path!)).toEqual(Buffer.alloc(bytes, 0x61));
        }
      }
      if (source === "inline") {
        const { context } = await harness.receive("image", {
          attachments: [
            {
              id: "image",
              kind: "image",
              mimeType: "image/png",
              fileName: "image.png",
              contentBase64: QA_GENERATED_IMAGE_BASE64,
            },
          ],
        });
        expect(context.media).toHaveLength(1);
        expect(context.media?.[0]).toMatchObject({ contentType: "image/png" });
        expect(path.basename(context.media?.[0]?.path ?? "")).toMatch(
          /^image---[a-f0-9-]{36}\.png$/,
        );
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
    const fixture = await busFixture({ namedAccount: true });
    state = fixture.state;
    cfg = fixture.cfg;
  });
  async function act(
    action: ChannelMessageActionName,
    params: Record<string, unknown>,
    accountId = "default",
  ) {
    return extractToolPayload(
      await qaChannelPlugin.actions!.handleAction!({
        channel: "qa-channel",
        action,
        cfg,
        accountId,
        params,
      }),
    );
  }
  async function expectMessage(
    action: ChannelMessageActionName,
    params: Record<string, unknown>,
    message: unknown,
  ) {
    const result = await act(action, params);
    expect(result).toMatchObject({ message });
    if (action === "thread-reply") {
      const reply = result as { message: { id: string } };
      expect(result).toMatchObject({
        receipt: {
          primaryPlatformMessageId: reply.message.id,
          threadId: params.threadId,
          parts: [{ threadId: params.threadId }],
        },
      });
    }
  }
  async function createThread(params: Record<string, unknown>) {
    return (await act("thread-create", params)) as ThreadResult;
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

  it("describes the legacy title alias", () => {
    expect(
      qaChannelPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "default",
      })?.schema,
    ).toMatchObject({
      properties: { title: { description: "Deprecated alias for threadName." } },
    });
  });
  it.each([false, true])("preserves thread/edit fields (legacy=%s)", async (legacy) => {
    const { thread, target, threadId } = await createThread({
      ...(legacy ? { channelId: "a/b" } : { target: "channel:a/b", to: "old", channelId: "old" }),
      ...(legacy ? { title: "Title" } : { threadName: "Title", title: "ignored" }),
    });
    expect({ thread, target, threadId }).toMatchObject({
      thread: { id: expect.stringMatching(/^thread-/), conversationId: "a/b", title: "Title" },
      target: "channel:a/b",
      threadId: thread.id,
    });
    await expectMessage(
      "thread-reply",
      {
        threadId,
        ...(legacy
          ? { channelId: "a/b", text: "reply" }
          : {
              target,
              channelId: "old",
              message: "reply",
              text: "ignored",
            }),
      },
      { conversation: { id: "a/b", kind: "channel" }, text: "reply", threadId },
    );
    const outbound = add(target, "before", { threadId });
    const binding = { to: target, threadId, messageId: outbound.id };
    const edit = legacy ? { text: "edit" } : { text: "ignored", message: "edit" };
    await expectMessage("edit", { ...binding, ...edit }, { text: "edit" });
    await expectMessage("read", binding, { text: "edit" });
    expect(state.readMessage({ messageId: outbound.id }).text).toBe("edit");
    expect(await search({ query: "edit", channelId: "a/b", threadId })).toContain(outbound.id);
  });
  it.each([
    ["thread:/v1/dm/Alice/Topic", "Alice", "direct", "Topic"],
    ["thread:/v1/group/Room%2FOne/Topic%2FTwo", "Room/One", "group", "Topic/Two"],
  ] as const)("preserves versioned target %s", async (target, id, kind, threadId) => {
    await expectMessage(
      "send",
      { target, message: "versioned target" },
      { conversation: { id, kind }, text: "versioned target", threadId },
    );
  });
  it("rejects every message action after deletion", async () => {
    const deleted = add("channel:qa-room", "deleted");
    const binding = { to: "channel:qa-room", messageId: deleted.id };
    await act("delete", binding);
    await rejectsMessageActions(binding, "qa-channel message was deleted");
    expect(state.readMessage({ messageId: deleted.id }).deleted).toBe(true);
  });
  it("binds thread replies to the owning account and conversation", async () => {
    const thread = state.createThread({ conversationId: "qa-room", title: "Owned" });
    for (const [accountId, channelId] of [
      ["other", "qa-room"],
      ["default", "other-room"],
    ]) {
      await expect(
        act("thread-reply", { channelId, threadId: thread.id, text: "foreign" }, accountId),
      ).rejects.toThrow("qa-bus thread not found in selected account and conversation");
    }
    expect(state.getSnapshot()).toMatchObject({
      messages: [],
      conversations: [{ accountId: "default", id: "qa-room", kind: "channel" }],
    });
    await expectMessage(
      "thread-reply",
      {
        to: "channel:qa-room",
        threadId: thread.id,
        message: "owned",
      },
      { threadId: thread.id },
    );
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
    for (const [params, error] of [
      [{ channelId: "CHANNEL:allowed" }, "qa-channel target prefixes must be lowercase"],
      [{ threadId: "thread-1" }, "qa-channel search requires channelId when threadId is provided"],
      [{ channelId: "channel:" }, "invalid qa-channel channel target"],
    ] as const) {
      await expect(search(params)).rejects.toThrow(error);
    }
    const unchanged = state.readMessage({ accountId: "default", messageId: foreign.id });
    expect(unchanged).toMatchObject({ text: "needle foreign root", reactions: [] });
    expect(unchanged.deleted).not.toBe(true);
  });
  it("routes advertised sends and rejects conflicting thread metadata", async () => {
    expect(
      qaChannelPlugin.actions?.extractToolSend?.({
        args: { action: "send", target: "qa-room", message: "hello" },
      }),
    ).toEqual({ to: "channel:qa-room", threadId: undefined });
    await expectMessage(
      "send",
      { target: "qa-room", message: "hello from action" },
      { text: "hello from action" },
    );
    await expect(
      act("send", { to: "thread:qa-room/thread-1", threadId: "thread-2", message: "conflicting" }),
    ).rejects.toThrow("qa-channel target conflicts with the explicit threadId");
    expect(state.getSnapshot().messages).toMatchObject([
      { text: "hello from action", conversation: { id: "qa-room", kind: "channel" } },
    ]);
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
    const final = state.getSnapshot().messages.at(-1);
    expect(final?.toolCalls).toEqual([{ name: "exec", arguments: args }]);
  }, params);
});
