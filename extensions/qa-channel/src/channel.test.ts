import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { qaChannelPlugin, setQaChannelRuntime } from "../api.js";
import { listQaChannelAccountIds, resolveDefaultQaChannelAccountId } from "./accounts.js";
import type { QaBusInboundMessageInput } from "./bus-client.js";

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

function installQaChannelTestRegistry() {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
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

function requireQaStartAccount() {
  const startAccount = qaChannelPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("expected qa-channel gateway startAccount");
  }
  return startAccount;
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
  installQaChannelTestRegistry();
  const state = createQaBusState();
  const bus = await startQaBusServer({ state });
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
  const startAccount = requireQaStartAccount();
  const task = startAccount(
    createStartAccountContext({
      account,
      cfg,
      abortSignal: abort.signal,
    }),
  );
  stops.push(async () => {
    abort.abort();
    try {
      await task;
    } finally {
      await bus.stop();
    }
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

  it("backs declared message adapter capabilities with qa bus sends", async () => {
    const harness = await startQaChannelTestHarness({ allowFrom: ["*"] });
    const adapter = requireQaMessageAdapter();
    expect(qaChannelPlugin.capabilities.media).toBe(true);

    const sendContext = {
      cfg: createQaChannelConfig({ baseUrl: harness.baseUrl, allowFrom: ["*"] }),
      to: "thread:qa-room/thread-1",
      accountId: "default",
      replyToId: "parent-1",
    };
    const proveText = async () => {
      const onPlatformSendDispatch = vi.fn(async () => {});
      const assertDirectAdapterHandoff = vi.fn();
      const result = await adapter.send!.text!({
        ...sendContext,
        text: "hello",
        onPlatformSendDispatch,
        assertDirectAdapterHandoff,
      });
      expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
      expect(assertDirectAdapterHandoff).toHaveBeenCalled();
      expect(result.receipt.parts[0]).toMatchObject({
        kind: "text",
        replyToId: "parent-1",
        threadId: "thread-1",
      });
    };
    const proveMedia = async (kind: "media" | "payload" = "media") => {
      const onPlatformSendDispatch = vi.fn(async () => {});
      const assertDirectAdapterHandoff = vi.fn();
      const before = harness.state.getSnapshot().messages.length;
      const mediaPath = path.join(process.cwd(), "qa-channel-generated-capability.png");
      const context = {
        ...sendContext,
        text: "generated image",
        mediaUrl: mediaPath,
        mediaLocalRoots: [process.cwd()],
        mediaReadFile: async (filePath: string) => {
          expect(filePath).toBe(mediaPath);
          return Buffer.from(QA_GENERATED_IMAGE_BASE64, "base64");
        },
        onPlatformSendDispatch,
        assertDirectAdapterHandoff,
      };
      const result =
        kind === "payload"
          ? await adapter.send!.payload!({
              ...context,
              payload: {
                text: context.text,
                mediaUrl: mediaPath,
                mediaUrls: [mediaPath],
                isError: true,
              },
            })
          : await adapter.send!.media!(context);
      expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
      expect(assertDirectAdapterHandoff).toHaveBeenCalled();
      expect(result.receipt.parts[0]).toMatchObject({
        kind: "media",
        replyToId: "parent-1",
        threadId: "thread-1",
      });
      const messages = harness.state.getSnapshot().messages.slice(before);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: result.messageId,
        text: context.text,
        threadId: "thread-1",
        replyToId: "parent-1",
        attachments: [
          {
            kind: "image",
            mimeType: "image/png",
            fileName: "qa-channel-generated-capability.png",
            contentBase64: QA_GENERATED_IMAGE_BASE64,
          },
        ],
      });
      if (kind === "payload") {
        expect(messages[0]?.isError).toBe(true);
      }
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "qaChannelMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        payload: () => proveMedia("payload"),
        replyTo: proveText,
        thread: proveText,
        messageSendingHooks: () => {
          expect(adapter.send!.text).toBeTypeOf("function");
        },
      },
    });
  });

  it.for(["aborted", "revoked", "current"] as const)(
    "fences media sends after preparation: %s",
    async (authority, { signal }) => {
      installQaChannelTestRegistry();
      const state = createQaBusState();
      const bus = await startQaBusServer({ state });
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
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
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
        expect(result.status).toBe(authority === "current" ? "fulfilled" : "rejected");
        if (authority !== "current") {
          expect(result).toMatchObject({
            status: "rejected",
            error: expect.any(PlatformMessageNotDispatchedError),
          });
          expect(
            result.status === "rejected" &&
              result.error instanceof PlatformMessageNotDispatchedError &&
              result.error.cause,
          ).toBe(authority === "aborted" ? abort.signal.reason : revoked);
          if (authority === "aborted") {
            expect(onPlatformSendDispatch).not.toHaveBeenCalled();
          } else {
            expect(assertDirectAdapterHandoff).toHaveBeenCalled();
          }
          return;
        }
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
          await bus.stop();
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
      const harness = await startQaChannelTestHarness({
        allowFrom: ["*"],
      });

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
    const harness = await startQaChannelTestHarness({
      allowFrom: ["*"],
    });

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
