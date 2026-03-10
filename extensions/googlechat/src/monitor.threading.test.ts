import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/googlechat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "../../../src/test-utils/mock-http-response.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { handleGoogleChatWebhookRequest, registerGoogleChatWebhookTarget } from "./monitor.js";

const sendGoogleChatMessageMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/googlechat", () => ({
  createWebhookInFlightLimiter: vi.fn(() => ({})),
  createReplyPrefixOptions: vi.fn(() => ({})),
  registerWebhookTargetWithPluginRoute: vi.fn(
    ({
      targetsByPath,
      target,
    }: {
      targetsByPath: Map<string, unknown[]>;
      target: { path: string };
    }) => {
      const existing = targetsByPath.get(target.path) ?? [];
      targetsByPath.set(target.path, [...existing, target]);
      return {
        unregister: () => {
          const next = (targetsByPath.get(target.path) ?? []).filter((entry) => entry !== target);
          if (next.length > 0) {
            targetsByPath.set(target.path, next);
          } else {
            targetsByPath.delete(target.path);
          }
        },
      };
    },
  ),
  resolveInboundRouteEnvelopeBuilderWithRuntime: vi.fn(() => ({
    route: {
      sessionKey: "googlechat:session",
      accountId: "default",
      agentId: "assistant",
    },
    buildEnvelope: ({ body }: { body: string }) => ({
      storePath: "/tmp/googlechat-threading-test.md",
      body,
    }),
  })),
  resolveWebhookPath: vi.fn(() => "/googlechat"),
}));

vi.mock("./api.js", () => ({
  downloadGoogleChatMedia: vi.fn(),
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: sendGoogleChatMessageMock,
  updateGoogleChatMessage: vi.fn(),
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(async () => ({
    ok: true,
    commandAuthorized: true,
    effectiveWasMentioned: true,
    groupSystemPrompt: undefined,
  })),
  isSenderAllowed: vi.fn(),
}));

vi.mock("./monitor-webhook.js", () => ({
  createGoogleChatWebhookRequestHandler:
    ({
      webhookTargets,
      processEvent,
    }: {
      webhookTargets: Map<string, unknown[]>;
      processEvent: (event: unknown, target: unknown) => Promise<void>;
    }) =>
    async (req: IncomingMessage, res: ServerResponse) => {
      const target = webhookTargets.get(req.url ?? "/googlechat")?.[0];
      if (!target) {
        res.statusCode = 404;
        res.end("Not Found");
        return false;
      }
      const body = await readRequestBody(req);
      await processEvent(JSON.parse(body) as unknown, target);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
      return true;
    },
}));

function createWebhookRequest(payload: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    destroyed?: boolean;
    destroy: (error?: Error) => IncomingMessage;
    on: (event: string, listener: (...args: unknown[]) => void) => IncomingMessage;
  };
  req.method = "POST";
  req.url = "/googlechat";
  req.headers = {
    "content-type": "application/json",
  };
  req.destroyed = false;
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };

  const originalOn = req.on.bind(req);
  let bodyScheduled = false;
  req.on = ((event: string, listener: (...args: unknown[]) => void) => {
    const result = originalOn(event, listener);
    if (!bodyScheduled && event === "data") {
      bodyScheduled = true;
      void Promise.resolve().then(() => {
        req.emit("data", Buffer.from(JSON.stringify(payload), "utf-8"));
        if (!req.destroyed) {
          req.emit("end");
        }
      });
    }
    return result;
  }) as IncomingMessage["on"];

  return req;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on("end", () => resolve());
  });
  return Buffer.concat(chunks).toString("utf-8");
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      googlechat: {
        enabled: true,
        replyToMode: "off",
        serviceAccount: {
          type: "service_account",
          client_email: "bot@example.com",
          private_key: "test-key", // pragma: allowlist secret
          token_uri: "https://oauth2.googleapis.com/token",
        },
      },
    },
  };
}

function createAccount(
  config: Partial<ResolvedGoogleChatAccount["config"]> = {},
): ResolvedGoogleChatAccount {
  return {
    accountId: "default",
    enabled: true,
    credentialSource: "none",
    config,
  } as ResolvedGoogleChatAccount;
}

function createCore(params: {
  onRecordSessionMeta?: (args: unknown) => Promise<void> | void;
  onDispatchReply?: (args: {
    dispatcherOptions: {
      deliver: (payload: { text?: string; replyToId?: string }) => Promise<void>;
    };
  }) => Promise<void> | void;
}): PluginRuntime {
  return {
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      reply: {
        finalizeInboundContext: vi.fn((ctx) => ctx),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (args) => {
          await params.onDispatchReply?.(args);
        }),
      },
      session: {
        recordSessionMetaFromInbound: vi.fn(async (args) => {
          await params.onRecordSessionMeta?.(args);
        }),
      },
      media: {
        fetchRemoteMedia: vi.fn(),
        saveMediaBuffer: vi.fn(),
      },
      text: {
        resolveChunkMode: vi.fn(() => "sentences"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as PluginRuntime;
}

function createMessageEvent(threadName: string) {
  return {
    type: "MESSAGE",
    eventTime: "2026-03-10T00:00:00.000Z",
    space: {
      name: "spaces/AAA",
      type: "DM",
    },
    message: {
      name: "spaces/AAA/messages/msg-1",
      text: "hello",
      thread: {
        name: threadName,
      },
      sender: {
        name: "users/123",
        displayName: "Test User",
        email: "test@example.com",
        type: "HUMAN",
      },
    },
  };
}

describe("Google Chat monitor threading", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("records inbound MessageThreadId in session metadata", async () => {
    const threadName = "spaces/AAA/threads/thread-1";
    const recordSessionMetaFromInbound = vi.fn(async () => {});
    const core = createCore({
      onRecordSessionMeta: recordSessionMetaFromInbound,
    });
    const unregister = registerGoogleChatWebhookTarget({
      account: createAccount({ typingIndicator: "none" }),
      config: createConfig(),
      runtime: {},
      core,
      path: "/googlechat",
      mediaMaxMb: 5,
    });

    try {
      const handled = await handleGoogleChatWebhookRequest(
        createWebhookRequest(createMessageEvent(threadName)),
        createMockServerResponse(),
      );

      expect(handled).toBe(true);
      expect(recordSessionMetaFromInbound).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            ReplyToId: threadName,
            MessageThreadId: threadName,
          }),
        }),
      );
    } finally {
      unregister();
    }
  });

  it("uses the preserved inbound thread for immediate replies", async () => {
    const threadName = "spaces/AAA/threads/thread-2";
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/reply-1",
    });
    const core = createCore({
      onDispatchReply: async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Threaded reply" });
      },
    });
    const unregister = registerGoogleChatWebhookTarget({
      account: createAccount({ typingIndicator: "none" }),
      config: createConfig(),
      runtime: {},
      core,
      path: "/googlechat",
      mediaMaxMb: 5,
    });

    try {
      const handled = await handleGoogleChatWebhookRequest(
        createWebhookRequest(createMessageEvent(threadName)),
        createMockServerResponse(),
      );

      expect(handled).toBe(true);
      expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          space: "spaces/AAA",
          text: "Threaded reply",
          thread: threadName,
        }),
      );
    } finally {
      unregister();
    }
  });
});
