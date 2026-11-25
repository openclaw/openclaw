import type { ServerResponse } from "node:http";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import { slackOutbound } from "./outbound-adapter.js";
import { sendMessageSlack } from "./send.js";
import { clearSlackThreadParticipationCache } from "./sent-thread-cache.js";

const POST = "/api/chat.postMessage",
  OPEN = "/api/conversations.open";
const REVOKED = "direct delivery is no longer active";
function directOptions(cfg: OpenClawConfig, live = () => true) {
  const assertDirectAdapterHandoff = () => {
    if (!live()) {
      throw new Error(REVOKED);
    }
  };
  return { cfg, assertDirectAdapterHandoff };
}
function withSlackApi(
  respond: (url: string, attempt: number, response: ServerResponse) => object | Promise<object>,
  run: (cfg: OpenClawConfig, paths: string[]) => Promise<void>,
  slack: NonNullable<OpenClawConfig["channels"]>["slack"] = {},
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
      void Promise.resolve(respond(url, paths.length, response)).then((payload) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(payload));
      });
    },
    async (baseUrl) => {
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
      await run({ channels: { slack: { botToken: "xoxb-direct-authority", ...slack } } }, paths);
    },
  );
}
beforeEach(() => {
  const plugin = createOutboundTestPlugin({ id: "slack", outbound: slackOutbound });
  setActivePluginRegistry(createTestRegistry([{ pluginId: "slack", source: "test", plugin }]));
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearSlackThreadParticipationCache();
  resetPluginRuntimeStateForTest();
});

it.each(["core", "DM", "native"])("rechecks authority after %s preparation", async (stage) => {
  const dm = stage === "DM";
  const to = dm ? "user:U123" : "channel:C123";
  const response = dm
    ? { ok: true, channel: { id: "D123" } }
    : stage === "core"
      ? { ok: true, ts: "171234.1", channel: "C123" }
      : { ok: false, error: "invalid_blocks" };
  let live = true;
  await withSlackApi(
    () => {
      live = false;
      return response;
    },
    async (cfg, paths) => {
      const authority = directOptions(cfg, () => live);
      if (stage === "core") {
        const result = await sendDurableMessageBatch({
          ...authority,
          channel: "slack",
          to,
          payloads: [{ text: "alpha beta" }],
          skipQueue: true,
        });
        expect(result).toMatchObject({
          status: "partial_failed",
          results: [{ messageId: "171234.1" }],
        });
      } else {
        const rows = ["Account", "Acme"].map((text) => [{ type: "raw_text", text }]);
        const options = dm ? { threadTs: "171234.1" } : { blocks: [{ type: "data_table", rows }] };
        await expect(
          sendMessageSlack(to, "Pipeline", { ...authority, ...options }),
        ).rejects.toThrow(REVOKED);
      }
      expect(paths).toEqual([dm ? OPEN : POST]);
    },
    stage === "core" ? { textChunkLimit: 5 } : undefined,
  );
});

it("stops a revoked direct send after the per-target queue", async () => {
  const started = createDeferred<void>(),
    release = createDeferred<void>();
  await withSlackApi(
    async (_url, attempt) => {
      if (attempt === 1) {
        started.resolve();
        await release.promise;
      }
      return { ok: true, ts: `${attempt}.1`, channel: "C123" };
    },
    async (cfg, paths) => {
      const first = sendMessageSlack("channel:C123", "first", directOptions(cfg));
      await started.promise;
      let live = true;
      const options = directOptions(cfg, () => live);
      const secondError = sendMessageSlack("channel:C123", "second", options).catch(
        (error: unknown) => error,
      );
      live = false;
      release.resolve();
      await expect(first).resolves.toMatchObject({ messageId: "1.1" });
      expect(await secondError).toMatchObject({ message: expect.stringContaining(REVOKED) });
      expect(paths).toEqual([POST]);
    },
  );
});

it("reuses the credential-scoped DM cache across direct sends", async () => {
  await withSlackApi(
    (url, attempt) =>
      url === OPEN
        ? { ok: true, channel: { id: "D123" } }
        : { ok: true, ts: `${attempt}.1`, channel: "D123" },
    async (cfg, paths) => {
      const options = { ...directOptions(cfg), threadTs: "171234.1" };
      await sendMessageSlack("user:U123", "first", options);
      await sendMessageSlack("user:U123", "second", options);
      expect(paths).toEqual([OPEN, POST, POST]);
    },
  );
});
function interactiveAction(
  cfg: OpenClawConfig,
  action: ChannelMessageActionContext["action"],
  params: Record<string, unknown>,
  assertDirectAdapterHandoff?: () => void,
) {
  return createSlackActions("slack").handleAction!({
    channel: "slack",
    action,
    cfg,
    accountId: "default",
    requesterAccountId: "default",
    params,
    toolContext: { currentChannelProvider: "slack", currentChannelId: "channel:C_CURRENT" },
    assertDirectAdapterHandoff,
  });
}

it.each(["authorized lookup", "revoked lookup", "revoked retry", "accepted mutation"] as const)(
  "%s preserves the request authority boundary",
  async (scenario) => {
    let live = true;
    const accepted = scenario === "accepted mutation";
    const retry = scenario === "revoked retry";
    await withSlackApi(
      (path, attempt, response) => {
        if (scenario !== "authorized lookup") {
          live = false;
        }
        if (retry) {
          response.statusCode = 429;
          response.setHeader("retry-after", "0");
          return { ok: false, error: "ratelimited" };
        }
        return path === "/api/conversations.info"
          ? { ok: true, channel: { id: "C_TARGET", name: "allowed" } }
          : { ok: true, channel: accepted ? "C_CURRENT" : "C_TARGET", ts: `171234.${attempt}` };
      },
      async (cfg, paths) => {
        const authority = directOptions(cfg, () => live);
        const params = accepted
          ? { to: "C_CURRENT", message: "accepted" }
          : { channelId: "C_TARGET", messageId: "171234.1", message: "Updated" };
        const action = interactiveAction(
          cfg,
          accepted ? "send" : "edit",
          params,
          authority.assertDirectAdapterHandoff,
        );
        if (scenario.startsWith("revoked")) {
          await expect(action).rejects.toThrow(REVOKED);
          expect(paths).toEqual(["/api/conversations.info"]);
          return;
        }
        await expect(action).resolves.toMatchObject({ details: { ok: true } });
        if (accepted) {
          await expect(
            interactiveAction(cfg, "send", { to: "C_CURRENT", message: "ordinary" }),
          ).resolves.toMatchObject({ details: { ok: true } });
        }
        expect(paths).toEqual(
          accepted ? [POST, POST] : ["/api/conversations.info", "/api/chat.update"],
        );
      },
      {
        actions: { messages: true },
        groupPolicy: "allowlist",
        ...(!accepted
          ? { channels: { "#allowed": { enabled: true } }, dangerouslyAllowNameMatching: true }
          : {}),
      },
    );
  },
);
