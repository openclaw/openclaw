import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { extractToolPayload } from "openclaw/plugin-sdk/tool-payload";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { qaChannelPlugin, setQaChannelRuntime } from "../api.js";
import { listQaChannelAccountIds, resolveDefaultQaChannelAccountId } from "./accounts.js";
import type { QaBusInboundMessageInput, QaBusThread } from "./bus-client.js";

type QaDispatchTurn = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];

const QA_GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0nQAAAAASUVORK5CYII=";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    const failures: unknown[] = [];
    for (const stop of stops.splice(0)) {
      await stop().catch((error: unknown) => failures.push(error));
    }
    if (failures.length) {
      throw failures[0];
    }
  } finally {
    resetPluginRuntimeStateForTest();
    vi.unstubAllGlobals();
  }
});

describe("QA channel account resolution", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        "qa-channel": {
          baseUrl: "http://127.0.0.1:8787",
          accounts: {
            work: { enabled: false },
          },
        },
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

async function busFixture() {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
  const state = createQaBusState();
  const bus = await startQaBusServer({ state });
  stops.push(bus.stop);
  return { state, bus, cfg: createQaChannelConfig({ baseUrl: bus.baseUrl }) };
}

function createMockQaRuntime(params?: {
  onDispatch?: (ctx: Record<string, unknown>) => void;
  onTurn?: (turn: QaDispatchTurn) => void;
  toolStarts?: Array<{ name?: string; phase?: string; args?: Record<string, unknown> }>;
}): PluginRuntime {
  return createPluginRuntimeMock({
    channel: {
      mentions: {
        buildMentionRegexes() {
          return [/^@openclaw\b/i];
        },
        matchesMentionPatterns(text: string, patterns: RegExp[]) {
          return patterns.some((pattern) => pattern.test(text));
        },
      },
      inbound: {
        async dispatch(turn: QaDispatchTurn) {
          params?.onTurn?.(turn);
          for (const toolStart of params?.toolStarts ?? []) {
            await turn.replyOptions?.onToolStart?.(toolStart);
          }
          params?.onDispatch?.(turn.ctxPayload as Record<string, unknown>);
          await turn.delivery.deliver(
            {
              text: `qa-echo: ${turn.ctxPayload.BodyForAgent ?? turn.ctxPayload.Body ?? ""}`,
            },
            { kind: "final" },
          );
          return {
            admission: turn.admission ?? { kind: "dispatch" as const },
            dispatched: true,
            ctxPayload: turn.ctxPayload,
            routeSessionKey: turn.route.sessionKey,
            dispatchResult: undefined,
          };
        },
      },
    },
  } as unknown as PluginRuntime);
}

function createQaChannelConfig(params: {
  baseUrl: string;
  allowFrom?: string[];
  mediaMaxMb?: number;
}) {
  return {
    channels: {
      "qa-channel": {
        baseUrl: params.baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: params.allowFrom,
        mediaMaxMb: params.mediaMaxMb,
      },
    },
  };
}

function requireQaMessageAdapter() {
  const adapter = qaChannelPlugin.message;
  if (!adapter) {
    throw new Error("expected qa-channel message adapter");
  }
  return adapter;
}

async function startQaChannelTestHarness(params?: {
  runtime?: PluginRuntime;
  allowFrom?: string[];
  mediaMaxMb?: number;
}) {
  const { state, bus } = await busFixture();
  const contexts: Record<string, unknown>[] = [];
  setQaChannelRuntime(
    params?.runtime ??
      createMockQaRuntime({
        onDispatch: (ctx) => contexts.push(ctx),
      }),
  );
  const cfg = createQaChannelConfig({
    baseUrl: bus.baseUrl,
    allowFrom: params?.allowFrom,
    mediaMaxMb: params?.mediaMaxMb,
  });
  const account = qaChannelPlugin.config.resolveAccount(cfg, "default");
  const abort = new AbortController();
  const startAccount = qaChannelPlugin.gateway!.startAccount!;
  const task = startAccount(
    createStartAccountContext({
      account,
      cfg,
      abortSignal: abort.signal,
    }),
  );
  stops.unshift(async () => {
    abort.abort();
    await task;
  });
  return {
    state,
    contexts,
    baseUrl: bus.baseUrl,
    async receive(text: string, overrides: Partial<QaBusInboundMessageInput> = {}) {
      state.addInboundMessage({
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        senderName: "Alice",
        text,
        ...overrides,
      });
      return state.waitFor({
        kind: "message-text",
        direction: "outbound",
        textIncludes: `qa-echo: ${text}`,
        timeoutMs: 15_000,
      });
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
  it("derives group outbound session routes from explicit group targets", async () => {
    const resolved = await route("group:qa-room");

    expect(resolved).toMatchObject({
      sessionKey: "agent:main:qa-channel:group:group:qa-room",
      baseSessionKey: "agent:main:qa-channel:group:group:qa-room",
      chatType: "group",
      to: "group:qa-room",
    });
  });

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

  it("recovers thread-aware outbound session routes from currentSessionKey", async () => {
    const resolved = await route("channel:qa-room", {
      currentSessionKey: "agent:main:qa-channel:channel:channel:qa-room:thread:thread-1",
    });

    expect(resolved?.sessionKey).toBe(
      "agent:main:qa-channel:channel:channel:qa-room:thread:thread-1",
    );
    expect(resolved?.baseSessionKey).toBe("agent:main:qa-channel:channel:channel:qa-room");
    expect(resolved?.threadId).toBe("thread-1");
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', async () => {
    const resolved = await route("dm:alice", {
      currentSessionKey: "agent:main:main:thread:thread-1",
    });

    expect(resolved).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });
    expect(resolved?.threadId).toBeUndefined();
  });

  it.each(["text", "media", "payload"] as const)(
    "delivers the %s adapter contract",
    async (kind) => {
      const { state, cfg } = await busFixture();
      const onPlatformSendDispatch = vi.fn(async () => {});
      const assertDirectAdapterHandoff = vi.fn();
      const mediaUrl = path.join(process.cwd(), "qa-channel-generated-capability.png");
      const text = "generated image";
      expect(qaChannelPlugin.capabilities.media).toBe(true);
      const result = await requireQaMessageAdapter().send![kind]!({
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
      expect(state.getSnapshot().messages).toMatchObject([
        {
          id: result.messageId,
          text,
          threadId: "thread-1",
          replyToId: "parent-1",
          ...(kind === "text"
            ? {}
            : {
                attachments: [
                  {
                    kind: "image",
                    mimeType: "image/png",
                    fileName: "qa-channel-generated-capability.png",
                    contentBase64: QA_GENERATED_IMAGE_BASE64,
                  },
                ],
              }),
          ...(kind === "payload" ? { isError: true } : {}),
        },
      ]);
    },
  );

  it.for(["aborted", "revoked", "current"] as const)(
    "fences media sends after preparation: %s",
    async (authority, { signal }) => {
      const { state, bus } = await busFixture();
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
      const sending = requireQaMessageAdapter().send!.media!({
        cfg: createQaChannelConfig({ baseUrl: bus.baseUrl }),
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
        expect(result).toBeUndefined();
        await expect(sending).resolves.toBeDefined();
        expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
        expect(assertDirectAdapterHandoff).toHaveBeenCalled();
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
        try {
          await settled;
        } finally {
          request.mockRestore();
        }
      }
    },
  );

  it(
    "attaches original agent tool starts to outbound qa bus messages",
    { timeout: 20_000 },
    async () => {
      const harness = await startQaChannelTestHarness({
        allowFrom: ["*"],
        runtime: createMockQaRuntime({
          onTurn: (turn) => {
            expect(turn.replyOptions?.allowToolLifecycleWhenProgressHidden).toBe(true);
          },
          toolStarts: [
            {
              name: "exec",
              phase: "start",
              args: {
                command: "pwd",
                apiToken: "secret-token",
              },
            },
            {
              name: "exec",
              phase: "update",
              args: {
                command: "ignored update",
              },
            },
          ],
        }),
      });

      const outbound = await harness.receive("hello");

      expect("toolCalls" in outbound ? outbound.toolCalls : undefined).toEqual([
        {
          name: "exec",
          arguments: {
            command: "pwd",
            apiToken: "secret-token",
          },
        },
      ]);
    },
  );

  it(
    "surfaces shared group traffic with the room target as From",
    { timeout: 20_000 },
    async () => {
      const harness = await startQaChannelTestHarness({ allowFrom: ["*"] });

      const outbound = await harness.receive("@openclaw hello", {
        conversation: { id: "qa-room", kind: "group", title: "QA Room" },
      });

      const ctx = harness.contexts[0];
      expect(ctx).toMatchObject({
        ChatType: "group",
        From: "group:qa-room",
        To: "group:qa-room",
        SessionKey: "agent:main:qa-channel:group:group:qa-room",
        SenderId: "alice",
        GroupSubject: "QA Room",
        WasMentioned: true,
      });
      expect(outbound).toMatchObject({ conversation: { id: "qa-room", kind: "group" } });
    },
  );

  it("stages inbound image attachments into agent media payload", { timeout: 20_000 }, async () => {
    const harness = await startQaChannelTestHarness({});

    await harness.receive("describe this image", {
      attachments: [
        {
          id: "image-1",
          kind: "image",
          mimeType: "image/png",
          fileName: "red-top-blue-bottom.png",
          contentBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8Dwn4GBgYGJAQoAHxcCAr7cGDwAAAAASUVORK5CYII=",
        },
      ],
    });

    const mediaCtx = harness.contexts[0] as {
      media?: Array<{ path?: string; contentType?: string }>;
    };
    const media = mediaCtx.media?.[0];
    expect(typeof media?.path).toBe("string");
    expect(path.basename(media?.path ?? "")).toMatch(/^red-top-blue-bottom---[a-f0-9-]{36}\.png$/);
    expect(media?.contentType).toBe("image/png");
    expect(mediaCtx.media).toHaveLength(1);
  });

  it.each(
    (["inline", "remote"] as const).flatMap((source) => [
      { source, mediaMaxMb: 1 / 1024, capBytes: 1024 },
      { source, mediaMaxMb: 0.3, capBytes: 314572 },
    ]),
  )(
    "enforces the $mediaMaxMb MiB $source inbound cap without stopping subsequent messages",
    async ({ source, mediaMaxMb, capBytes }) => {
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
      const harness = await startQaChannelTestHarness({
        allowFrom: ["*"],
        mediaMaxMb,
      });
      const inputs = [
        ["exact", capBytes],
        ["just-over", capBytes + 1],
        ["far-over", capBytes * 4],
        ["small", 512],
      ] as const;
      for (const [text, bytes] of inputs) {
        await harness.receive(text, {
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
      }
      expect(harness.contexts).toHaveLength(inputs.length);
      for (const [index, [, bytes]] of inputs.entries()) {
        const context = harness.contexts[index]!;
        if (bytes > capBytes) {
          expect(context.media).toEqual([]);
          expect(context.BodyForAgent).toContain("attachment unavailable");
        } else {
          const media = context.media as Array<{ path: string }>;
          expect(media).toHaveLength(1);
          expect(await readFile(media[0]!.path)).toEqual(Buffer.alloc(bytes, 0x61));
        }
      }
    },
  );
});

describe("message action bus", () => {
  const wrongConversation = "qa-channel message is not in the selected conversation";
  type ThreadResult = { thread: QaBusThread; target: string; threadId: string };

  let state: ReturnType<typeof createQaBusState>;
  let cfg: ReturnType<typeof config>;

  function config(baseUrl: string) {
    return {
      channels: {
        "qa-channel": {
          baseUrl,
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          accounts: { other: { baseUrl } },
        },
      },
    };
  }

  beforeEach(async () => {
    const fixture = await busFixture();
    state = fixture.state;
    cfg = config(fixture.bus.baseUrl);
  });

  async function act(
    action: ChannelMessageActionName,
    params: Record<string, unknown>,
    accountId = "default",
  ) {
    const handleAction = qaChannelPlugin.actions?.handleAction;
    if (!handleAction) {
      throw new Error("expected qa-channel action handler");
    }
    return extractToolPayload(
      await handleAction({ channel: "qa-channel", action, cfg, accountId, params }),
    );
  }

  async function expectAction(
    action: ChannelMessageActionName,
    params: Record<string, unknown>,
    expected: unknown,
  ) {
    await expect(act(action, params)).resolves.toMatchObject(expected);
  }
  async function createThread(params: Record<string, unknown>) {
    return (await act("thread-create", params)) as ThreadResult;
  }

  function boundThread(thread: ThreadResult) {
    return { target: thread.target, threadId: thread.threadId };
  }

  function search(params: Record<string, unknown>, accountId = "default") {
    return act("search", { query: "needle", ...params }, accountId).then((payload) =>
      (payload as { messages: Array<{ id: string }> }).messages.map((message) => message.id),
    );
  }

  it("describes the legacy title alias", () => {
    const schema = qaChannelPlugin.actions?.describeMessageTool?.({
      cfg,
      accountId: "default",
    })?.schema;
    const contributions = Array.isArray(schema) ? schema : schema ? [schema] : [];
    expect(
      contributions.find((entry) => "title" in entry.properties)?.properties.title,
    ).toMatchObject({
      description: "Deprecated alias for threadName.",
    });
  });

  it("prefers canonical targets over conflicting direct-adapter aliases", async () => {
    const threadPayload = await createThread({
      target: "channel:canonical/room",
      to: "channel:legacy-to-room",
      channelId: "legacy-channel-id-room",
      threadName: "Canonical",
      title: "ignored",
    });

    expect(threadPayload).toMatchObject({
      thread: {
        id: expect.stringMatching(/^thread-/),
        conversationId: "canonical/room",
        title: "Canonical",
      },
      target: "channel:canonical/room",
      threadId: threadPayload.thread.id,
    });

    await expectAction(
      "thread-reply",
      {
        ...boundThread(threadPayload),
        channelId: "legacy-reply-room",
        message: "reply",
        text: "ignored",
      },
      {
        message: {
          conversation: { id: "canonical/room", kind: "channel" },
          text: "reply",
          threadId: threadPayload.thread.id,
        },
      },
    );
  });

  it.each([
    ["thread:/v1/dm/Alice/Topic", "Alice", "direct", "Topic"],
    ["thread:/v1/group/Room%2FOne/Topic%2FTwo", "Room/One", "group", "Topic/Two"],
  ] as const)("preserves versioned target %s", async (target, id, kind, threadId) => {
    await expectAction(
      "send",
      { target, message: "versioned target" },
      {
        message: { conversation: { id, kind }, text: "versioned target", threadId },
      },
    );
  });

  it.each([
    [{ text: "legacy edit" }, "legacy edit"],
    [{ text: "ignored legacy edit", message: "canonical edit" }, "canonical edit"],
  ] as const)(
    "keeps direct API aliases and prefers canonical edit fields: %j",
    async (edit, text) => {
      const threadPayload = await createThread({
        channelId: "qa-room",
        title: "Legacy",
      });
      expect(threadPayload.thread.title).toBe("Legacy");

      await expectAction(
        "thread-reply",
        {
          channelId: "qa-room",
          threadId: threadPayload.thread.id,
          text: "reply",
        },
        {
          message: {
            text: "reply",
            threadId: threadPayload.thread.id,
          },
        },
      );

      const outbound = state.addOutboundMessage({
        to: threadPayload.target,
        text: "before",
        threadId: threadPayload.thread.id,
      });
      const target = { ...boundThread(threadPayload), messageId: outbound.id };
      await expectAction("edit", { ...target, ...edit }, { message: { text } });
      expect(state.readMessage({ messageId: outbound.id }).text).toBe(text);
      await expectAction("read", target, { message: { text } });
      expect(
        await search({ query: "edit", channelId: "qa-room", threadId: threadPayload.threadId }),
      ).toContain(outbound.id);
    },
  );
  it("keeps deleted messages out of channel actions and makes reactions idempotent", async () => {
    const live = state.addOutboundMessage({ to: "channel:qa-room", text: "needle live" });
    const deleted = state.addOutboundMessage({ to: "channel:qa-room", text: "needle deleted" });
    const reactionParams = {
      to: "channel:qa-room",
      messageId: deleted.id,
      emoji: "eyes",
    };

    await act("react", reactionParams);
    const cursorAfterReaction = state.getSnapshot().cursor;
    await act("react", reactionParams);
    expect(state.getSnapshot().cursor).toBe(cursorAfterReaction);
    expect(state.readMessage({ messageId: deleted.id }).reactions).toHaveLength(1);

    await act("delete", { to: "channel:qa-room", messageId: deleted.id });

    for (const action of ["read", "reactions", "react", "edit", "delete"] as const) {
      await expect(
        act(action, {
          to: "channel:qa-room",
          messageId: deleted.id,
          ...(action === "react" ? { emoji: "eyes" } : {}),
          ...(action === "edit" ? { text: "edited after deletion" } : {}),
        }),
      ).rejects.toThrow("qa-channel message was deleted");
    }

    expect(await search({ channelId: "qa-room" })).toEqual([live.id]);
    expect(state.readMessage({ messageId: deleted.id }).deleted).toBe(true);
  });

  it("rejects thread replies outside the owning account and conversation", async () => {
    const thread = state.createThread({ conversationId: "qa-room", title: "Owned thread" });

    for (const attempt of [
      { accountId: "other", channelId: "qa-room" },
      { accountId: "default", channelId: "other-room" },
    ]) {
      await expect(
        act(
          "thread-reply",
          {
            channelId: attempt.channelId,
            threadId: thread.id,
            text: "foreign reply",
          },
          attempt.accountId,
        ),
      ).rejects.toThrow("qa-bus thread not found in selected account and conversation");
    }
    expect(state.getSnapshot().messages).toEqual([]);
    expect(state.getSnapshot().conversations).toEqual([
      { accountId: "default", id: "qa-room", kind: "channel" },
    ]);

    const result = await act("thread-reply", {
      to: "channel:qa-room",
      threadId: thread.id,
      message: "owned reply",
    });
    const payload = result as {
      message: { id: string; threadId: string };
      receipt: {
        primaryPlatformMessageId?: string;
        threadId?: string;
        parts: Array<{ threadId?: string }>;
      };
    };
    expect(payload.message.threadId).toBe(thread.id);
    expect(payload.receipt).toMatchObject({
      primaryPlatformMessageId: payload.message.id,
      threadId: thread.id,
      parts: [{ threadId: thread.id }],
    });
  });

  it("binds message-id actions and searches to the selected account and conversation", async () => {
    const addMessage = (
      to: string,
      text: string,
      extra: Partial<Parameters<typeof state.addOutboundMessage>[0]> = {},
    ) => state.addOutboundMessage({ accountId: "default", to, text, ...extra });
    const allowedRoot = addMessage("channel:allowed", "needle allowed root");
    const foreignRoot = addMessage("channel:other", "needle foreign root");
    const allowedThread = addMessage("thread:allowed/thread-1", "needle allowed thread", {
      threadId: "thread-1",
    });
    const foreignAccount = addMessage("channel:allowed", "needle foreign account", {
      accountId: "other",
    });

    const crossedActions: Array<{
      action: ChannelMessageActionName;
      params: Record<string, unknown>;
    }> = [
      { action: "read", params: {} },
      { action: "reactions", params: {} },
      { action: "react", params: { emoji: "eyes" } },
      { action: "edit", params: { message: "foreign edit" } },
      { action: "delete", params: {} },
    ];
    for (const testCase of crossedActions) {
      await expect(
        act(testCase.action, {
          to: "channel:allowed",
          messageId: foreignRoot.id,
          ...testCase.params,
        }),
      ).rejects.toThrow("qa-channel message is not in the selected conversation");
    }

    await expect(
      act("read", { to: "channel:allowed", messageId: allowedRoot.id }, "other"),
    ).rejects.toThrow("qa-bus message not found");
    for (const [to, messageId] of [
      ["dm:allowed", allowedRoot.id],
      ["channel:allowed", allowedThread.id],
      ["thread:allowed/thread-2", allowedThread.id],
    ]) {
      await expect(act("read", { to, messageId })).rejects.toThrow(wrongConversation);
    }

    await expect(
      act("read", { to: "thread:allowed/thread-1", messageId: allowedThread.id }),
    ).resolves.toBeDefined();

    await expect(search({ channelId: "allowed" })).resolves.toEqual([allowedRoot.id]);
    await expect(search({ channelId: "CHANNEL:allowed" })).rejects.toThrow(
      "qa-channel target prefixes must be lowercase",
    );
    await expect(search({ channelId: "thread:allowed/thread-1" })).resolves.toEqual([
      allowedThread.id,
    ]);
    await expect(search({ channelId: "dm:allowed" })).resolves.toEqual([]);
    await expect(search({ channelId: "allowed" }, "other")).resolves.toEqual([foreignAccount.id]);
    await expect(search({})).resolves.toEqual([allowedRoot.id, foreignRoot.id, allowedThread.id]);
    await expect(search({ threadId: "thread-1" })).rejects.toThrow(
      "qa-channel search requires channelId when threadId is provided",
    );
    await expect(search({ channelId: "channel:" })).rejects.toThrow(
      "invalid qa-channel channel target",
    );

    const unchanged = state.readMessage({ accountId: "default", messageId: foreignRoot.id });
    expect(unchanged.text).toBe("needle foreign root");
    expect(unchanged.deleted).not.toBe(true);
    expect(unchanged.reactions).toEqual([]);
  });

  it("routes the advertised send action to the qa bus", async () => {
    expect(
      qaChannelPlugin.actions?.extractToolSend?.({
        args: { action: "send", target: "qa-room", message: "hello" },
      }),
    ).toEqual({ to: "channel:qa-room", threadId: undefined });

    expect(
      qaChannelPlugin.actions?.extractToolSend?.({
        args: { action: "thread-reply", channelId: "canonical/room", threadId: "thread-1" },
      }),
    ).toEqual({
      to: "channel:canonical/room",
      threadId: "thread-1",
    });

    const result = await act("send", {
      target: "qa-room",
      message: "hello from action",
    });
    const payload = result as { message: { text: string } };
    expect(payload.message.text).toBe("hello from action");

    await expect(
      act("send", {
        to: "thread:qa-room/thread-1",
        threadId: "thread-2",
        message: "conflicting thread",
      }),
    ).rejects.toThrow("qa-channel target conflicts with the explicit threadId");

    const outbound = await state.waitFor({
      kind: "message-text",
      direction: "outbound",
      textIncludes: "hello from action",
      timeoutMs: 5_000,
    });
    expect(outbound).toMatchObject({ conversation: { id: "qa-room", kind: "channel" } });
  });
});
