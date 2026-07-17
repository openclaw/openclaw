// Zalo reply delivery failure propagation covered against a real Bot API HTTP stub.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createEmptyPluginRegistry,
  createRuntimeEnv,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorZaloProvider } from "./monitor.js";
import type { PluginRuntime } from "./runtime-api.js";
import { setZaloRuntime } from "./runtime.js";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  postWebhookReplay,
  settleAsyncWork,
} from "./test-support/lifecycle-test-support.js";

describe("Zalo reply delivery failure propagation", () => {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordInboundSessionMock = vi.fn(async () => undefined);
  const dispatchReplyWithBufferedBlockDispatcherMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePluginRegistry(createEmptyPluginRegistry());
    setZaloRuntime(
      createPluginRuntimeMock({
        channel: {
          reply: {
            finalizeInboundContext:
              finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
            dispatchReplyWithBufferedBlockDispatcher:
              dispatchReplyWithBufferedBlockDispatcherMock as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
          },
          session: {
            recordInboundSession:
              recordInboundSessionMock as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
          },
        },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("propagates Bot API send failures from deliver instead of reporting the reply as delivered", async () => {
    const sendAttempts: Array<{ chat_id?: string; text?: string }> = [];
    let deliverError: unknown;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async ({ dispatcherOptions }) => {
        try {
          await dispatcherOptions.deliver({ text: "zalo delivery failure probe" });
        } catch (err) {
          deliverError = err;
          dispatcherOptions.onError?.(err, { kind: "final" });
        }
      },
    );

    await withServer(
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const url = req.url ?? "";
          if (url.endsWith("/sendMessage")) {
            sendAttempts.push(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                chat_id?: string;
                text?: string;
              },
            );
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({ ok: false, error_code: 500, description: "stub: send disabled" }),
            );
            return;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, result: { url: "" } }));
        });
      },
      async (zaloApiUrl) => {
        vi.stubEnv("ZALO_API_URL", zaloApiUrl);
        const registry = createEmptyPluginRegistry();
        setActivePluginRegistry(registry);
        const abort = new AbortController();
        const setup = createLifecycleMonitorSetup({
          accountId: "acct-zalo-delivery-failure",
          dmPolicy: "open",
        });
        const run = monitorZaloProvider({
          token: "zalo-token",
          account: setup.account,
          config: setup.config,
          runtime: createRuntimeEnv(),
          abortSignal: abort.signal,
          useWebhook: true,
          webhookUrl: "https://example.com/hooks/zalo",
          webhookSecret: "supersecret",
        });

        try {
          await vi.waitFor(
            () => {
              if (!registry.httpRoutes.some((route) => route.source === "zalo-webhook")) {
                throw new Error("waiting for webhook registration");
              }
            },
            { timeout: 15000 },
          );
          const route = registry.httpRoutes.find((entry) => entry.source === "zalo-webhook");
          if (!route) {
            throw new Error("missing plugin HTTP route");
          }

          await withServer(
            (req, res) => {
              void route.handler(req, res);
            },
            async (baseUrl) => {
              const { first } = await postWebhookReplay({
                baseUrl,
                path: "/hooks/zalo",
                secret: "supersecret",
                payload: createTextUpdate({
                  messageId: `zalo-delivery-failure-${Date.now()}`,
                  userId: "user-1",
                  userName: "User One",
                  chatId: "dm-chat-1",
                }),
              });
              expect(first.status).toBe(200);
              await settleAsyncWork();
            },
          );
        } finally {
          abort.abort();
          await run;
        }
      },
    );

    expect(sendAttempts).toHaveLength(1);
    expect(sendAttempts[0]?.chat_id).toBe("dm-chat-1");
    expect(sendAttempts[0]?.text).toBe("zalo delivery failure probe");
    expect(deliverError).toBeInstanceOf(Error);
    expect((deliverError as Error).message).toContain("stub: send disabled");
  });
});
