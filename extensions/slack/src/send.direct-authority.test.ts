import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createOutboundTestPlugin,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackOutbound } from "./outbound-adapter.js";
import { sendMessageSlack } from "./send.js";
import { clearSlackThreadParticipationCache } from "./sent-thread-cache.js";

function withSlackApi(
  respond: (url: string, attempt: number) => object | Promise<object>,
  run: (cfg: OpenClawConfig, paths: string[]) => Promise<void>,
  textChunkLimit?: number,
) {
  const paths: string[] = [];
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
  return withServer(
    (request, response) => {
      const url = request.url ?? "";
      paths.push(url);
      request.resume();
      void Promise.resolve(respond(url, paths.length)).then((payload) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      });
    },
    async (baseUrl) => {
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
      await run(
        { channels: { slack: { botToken: "xoxb-direct-authority", textChunkLimit } } },
        paths,
      );
    },
  );
}
function assertLive(resolveLive: () => boolean) {
  return () => {
    if (!resolveLive()) {
      throw new Error("direct delivery is no longer active");
    }
  };
}
beforeEach(() =>
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        plugin: createOutboundTestPlugin({ id: "slack", outbound: slackOutbound }),
        source: "test",
      },
    ]),
  ),
);
afterEach(() => {
  vi.unstubAllEnvs();
  clearSlackThreadParticipationCache();
  resetPluginRuntimeStateForTest();
});

describe("Slack direct-delivery request authority", () => {
  it("carries core currentness through the adapter and actual transport", async () => {
    let live = true;
    await withSlackApi(
      () => {
        live = false;
        return { ok: true, ts: "171234.1", channel: "C123" };
      },
      async (cfg, paths) => {
        const result = await sendDurableMessageBatch({
          cfg,
          channel: "slack",
          to: "channel:C123",
          payloads: [{ text: "alpha beta" }],
          skipQueue: true,
          assertDirectAdapterHandoff: assertLive(() => live),
        });
        expect(result).toMatchObject({
          status: "partial_failed",
          results: [expect.objectContaining({ messageId: "171234.1" })],
        });
        expect(paths).toEqual(["/api/chat.postMessage"]);
      },
      5,
    );
  });

  it("stops a revoked direct send after the per-target queue", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    await withSlackApi(
      async (_url, attempt) => {
        if (attempt === 1) {
          started.resolve();
          await release.promise;
        }
        return { ok: true, ts: `${attempt}.1`, channel: "C123" };
      },
      async (cfg, paths) => {
        const first = sendMessageSlack("channel:C123", "first", {
          cfg,
          assertDirectAdapterHandoff: assertLive(() => true),
        });
        await started.promise;
        let live = true;
        const secondError = sendMessageSlack("channel:C123", "second", {
          cfg,
          assertDirectAdapterHandoff: assertLive(() => live),
        }).catch((error: unknown) => error);
        live = false;
        release.resolve();
        await expect(first).resolves.toMatchObject({ messageId: "1.1" });
        await expect(secondError).resolves.toMatchObject({
          message: expect.stringContaining("direct delivery is no longer active"),
        });
        expect(paths).toEqual(["/api/chat.postMessage"]);
      },
    );
  });

  it.each([
    {
      stage: "DM preparation",
      to: "user:U123",
      options: { threadTs: "171234.1" },
      response: { ok: true, channel: { id: "D123" } },
      path: "/api/conversations.open",
    },
    {
      stage: "native-data rejection",
      to: "channel:C123",
      options: {
        blocks: [
          {
            type: "data_table",
            rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
          },
        ],
      },
      response: { ok: false, error: "invalid_blocks" },
      path: "/api/chat.postMessage",
    },
  ])("stops a revoked direct send after $stage", async ({ to, options, response, path }) => {
    let live = true;
    await withSlackApi(
      () => {
        live = false;
        return response;
      },
      async (cfg, paths) => {
        await expect(
          sendMessageSlack(to, "Pipeline", {
            cfg,
            ...options,
            assertDirectAdapterHandoff: assertLive(() => live),
          }),
        ).rejects.toThrow("direct delivery is no longer active");
        expect(paths).toEqual([path]);
      },
    );
  });

  it("reuses the credential-scoped DM cache across direct sends", async () => {
    await withSlackApi(
      (url, attempt) =>
        url === "/api/conversations.open"
          ? { ok: true, channel: { id: "D123" } }
          : { ok: true, ts: `${attempt}.1`, channel: "D123" },
      async (cfg, paths) => {
        const options = {
          cfg,
          threadTs: "171234.1",
          assertDirectAdapterHandoff: assertLive(() => true),
        };
        await sendMessageSlack("user:U123", "first", options);
        await sendMessageSlack("user:U123", "second", options);
        expect(paths).toEqual([
          "/api/conversations.open",
          "/api/chat.postMessage",
          "/api/chat.postMessage",
        ]);
      },
    );
  });
});
