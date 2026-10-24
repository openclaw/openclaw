import type { ServerResponse } from "node:http";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import { clearSlackThreadParticipationCache } from "./sent-thread-cache.js";

function useSlackApi(baseUrl: string, namedTarget: boolean): OpenClawConfig {
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("SLACK_API_URL", baseUrl + "/api/");
  return {
    channels: {
      slack: {
        botToken: "xoxb-interactive-authority",
        actions: { messages: true },
        groupPolicy: "allowlist",
        ...(namedTarget
          ? { channels: { "#allowed": { enabled: true } }, dangerouslyAllowNameMatching: true }
          : {}),
      },
    },
  };
}
function respond(response: ServerResponse, payload: object, retry = false) {
  response.writeHead(retry ? 429 : 200, {
    "content-type": "application/json",
    ...(retry ? { "retry-after": "0" } : {}),
  });
  response.end(JSON.stringify(payload));
}
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
afterEach(() => {
  vi.unstubAllEnvs();
  clearSlackThreadParticipationCache();
});

it.each(["authorized lookup", "revoked lookup", "revoked retry", "accepted mutation"] as const)(
  "%s preserves the request authority boundary",
  async (scenario) => {
    const paths: string[] = [];
    let live = true;
    const accepted = scenario === "accepted mutation";
    const retry = scenario === "revoked retry";
    await withServer(
      (request, response) => {
        const path = request.url ?? "";
        paths.push(path);
        request.resume();
        if (scenario !== "authorized lookup") {
          live = false;
        }
        if (retry) {
          respond(response, { ok: false, error: "ratelimited" }, true);
        } else {
          respond(
            response,
            path === "/api/conversations.info"
              ? { ok: true, channel: { id: "C_TARGET", name: "allowed" } }
              : {
                  ok: true,
                  channel: accepted ? "C_CURRENT" : "C_TARGET",
                  ts: "171234." + paths.length,
                },
          );
        }
      },
      async (baseUrl) => {
        const cfg = useSlackApi(baseUrl, !accepted);
        const assertLive = () => {
          if (!live) {
            throw new Error("interactive action is no longer active");
          }
        };
        const action = accepted
          ? interactiveAction(cfg, "send", { to: "C_CURRENT", message: "accepted" }, assertLive)
          : interactiveAction(
              cfg,
              "edit",
              {
                channelId: retry ? "C_RETRY" : "C_TARGET",
                messageId: retry ? "171234.2" : "171234.1",
                message: "Updated",
              },
              assertLive,
            );
        if (scenario.startsWith("revoked")) {
          await expect(action).rejects.toThrow("interactive action is no longer active");
          expect(paths).toEqual(["/api/conversations.info"]);
        } else {
          await expect(action).resolves.toMatchObject({ details: { ok: true } });
          if (accepted) {
            await expect(
              interactiveAction(cfg, "send", { to: "C_CURRENT", message: "ordinary" }),
            ).resolves.toMatchObject({ details: { ok: true } });
            expect(paths).toEqual(["/api/chat.postMessage", "/api/chat.postMessage"]);
          } else {
            expect(paths).toEqual(["/api/conversations.info", "/api/chat.update"]);
          }
        }
      },
    );
  },
);
