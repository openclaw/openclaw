import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createOutboundTestPlugin,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
// Slack tests cover the real send queue, send owner, SDK and loopback transport.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackOutbound } from "./outbound-adapter.js";
import { sendMessageSlack } from "./send.js";
import { clearSlackThreadParticipationCache } from "./sent-thread-cache.js";

const BOT_TOKEN = "xoxb-direct-authority";
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

function useSlackApi(baseUrl: string, textChunkLimit?: number) {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
  return {
    channels: { slack: { botToken: BOT_TOKEN, ...(textChunkLimit ? { textChunkLimit } : {}) } },
  };
}

function sendSlackResponse(response: import("node:http").ServerResponse, payload: object): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function assertLive(resolveLive: () => boolean): () => void {
  return () => {
    if (!resolveLive()) {
      throw new Error("direct delivery is no longer active");
    }
  };
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        plugin: createOutboundTestPlugin({ id: "slack", outbound: slackOutbound }),
        source: "test",
      },
    ]),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearSlackThreadParticipationCache();
  resetPluginRuntimeStateForTest();
});

describe("Slack direct-delivery request authority", () => {
  it("carries core currentness through the adapter and actual transport", async () => {
    const paths: string[] = [];
    let isLive = true;
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        isLive = false;
        sendSlackResponse(response, { ok: true, ts: "171234.1", channel: "C123" });
      },
      async (baseUrl) => {
        const result = await sendDurableMessageBatch({
          cfg: useSlackApi(baseUrl, 5),
          channel: "slack",
          to: "channel:C123",
          payloads: [{ text: "alpha beta" }],
          skipQueue: true,
          assertDirectAdapterHandoff: assertLive(() => isLive),
        });

        expect(result).toMatchObject({
          status: "partial_failed",
          results: [expect.objectContaining({ messageId: "171234.1" })],
        });
        expect(paths).toEqual(["/api/chat.postMessage"]);
      },
    );
  });

  it("stops a revoked direct send after the per-target queue", async () => {
    const paths: string[] = [];
    const firstRequest = createDeferred<void>();
    const releaseFirstResponse = createDeferred<void>();
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        void (async () => {
          if (paths.length === 1) {
            firstRequest.resolve();
            await releaseFirstResponse.promise;
          }
          sendSlackResponse(response, { ok: true, ts: `${paths.length}.1`, channel: "C123" });
        })();
      },
      async (baseUrl) => {
        const cfg = useSlackApi(baseUrl);
        const first = sendMessageSlack("channel:C123", "first", {
          cfg,
          assertDirectAdapterHandoff: assertLive(() => true),
        });
        await firstRequest.promise;
        let secondIsLive = true;
        const secondError = sendMessageSlack("channel:C123", "second", {
          cfg,
          assertDirectAdapterHandoff: assertLive(() => secondIsLive),
        }).then(
          () => undefined,
          (error: unknown) => error,
        );

        secondIsLive = false;
        releaseFirstResponse.resolve();
        await expect(first).resolves.toMatchObject({ messageId: "1.1" });
        await expect(secondError).resolves.toMatchObject({
          message: expect.stringContaining("direct delivery is no longer active"),
        });
        expect(paths).toEqual(["/api/chat.postMessage"]);
      },
    );
  });

  it("stops a revoked direct send after DM preparation", async () => {
    const paths: string[] = [];
    let isLive = true;
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        isLive = false;
        sendSlackResponse(response, { ok: true, channel: { id: "D123" } });
      },
      async (baseUrl) => {
        await expect(
          sendMessageSlack("user:U123", "thread answer", {
            cfg: useSlackApi(baseUrl),
            threadTs: "171234.1",
            assertDirectAdapterHandoff: assertLive(() => isLive),
          }),
        ).rejects.toThrow("direct delivery is no longer active");
        expect(paths).toEqual(["/api/conversations.open"]);
      },
    );
  });

  it("reuses the credential-scoped DM cache across direct sends", async () => {
    const paths: string[] = [];
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        sendSlackResponse(
          response,
          request.url === "/api/conversations.open"
            ? { ok: true, channel: { id: "D123" } }
            : { ok: true, ts: `${paths.length}.1`, channel: "D123" },
        );
      },
      async (baseUrl) => {
        const cfg = useSlackApi(baseUrl);
        const sendOpts = {
          cfg,
          threadTs: "171234.1",
          assertDirectAdapterHandoff: assertLive(() => true),
        };

        await sendMessageSlack("user:U123", "first", sendOpts);
        await sendMessageSlack("user:U123", "second", sendOpts);
        expect(paths).toEqual([
          "/api/conversations.open",
          "/api/chat.postMessage",
          "/api/chat.postMessage",
        ]);
      },
    );
  });

  it("stops later chunks after direct authority is revoked", async () => {
    const paths: string[] = [];
    const onDeliveryResult = vi.fn();
    let isLive = true;
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        isLive = false;
        sendSlackResponse(response, { ok: true, ts: "171234.1", channel: "C123" });
      },
      async (baseUrl) => {
        await expect(
          sendMessageSlack("channel:C123", "alpha beta", {
            cfg: useSlackApi(baseUrl, 5),
            assertDirectAdapterHandoff: assertLive(() => isLive),
            onDeliveryResult,
          }),
        ).rejects.toThrow("direct delivery is no longer active");
        expect(paths).toEqual(["/api/chat.postMessage"]);
        expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ messageId: "171234.1" }),
        );
      },
    );
  });

  it("stops fallback messages after direct authority is revoked", async () => {
    const paths: string[] = [];
    let isLive = true;
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        isLive = false;
        sendSlackResponse(response, { ok: false, error: "invalid_blocks" });
      },
      async (baseUrl) => {
        await expect(
          sendMessageSlack("channel:C123", "Pipeline", {
            cfg: useSlackApi(baseUrl),
            blocks: [
              {
                type: "data_table",
                rows: [
                  [{ type: "raw_text", text: "Account" }],
                  [{ type: "raw_text", text: "Acme" }],
                ],
              },
            ] as never,
            assertDirectAdapterHandoff: assertLive(() => isLive),
          }),
        ).rejects.toThrow("direct delivery is no longer active");
        expect(paths).toEqual(["/api/chat.postMessage"]);
      },
    );
  });

  it("does not attach a direct-send callback to later ordinary writes", async () => {
    const paths: string[] = [];
    let isLive = true;
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        sendSlackResponse(response, { ok: true, ts: `${paths.length}.1`, channel: "C123" });
      },
      async (baseUrl) => {
        const cfg = useSlackApi(baseUrl);
        await sendMessageSlack("channel:C123", "direct", {
          cfg,
          assertDirectAdapterHandoff: assertLive(() => isLive),
        });
        isLive = false;

        await expect(sendMessageSlack("channel:C123", "ordinary", { cfg })).resolves.toMatchObject({
          messageId: "2.1",
        });
        expect(paths).toEqual(["/api/chat.postMessage", "/api/chat.postMessage"]);
      },
    );
  });
});
