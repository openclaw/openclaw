// Slack tests cover interactive action request authority.
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import { clearSlackThreadParticipationCache } from "./sent-thread-cache.js";

const BOT_TOKEN = "xoxb-interactive-authority";
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

function useSlackApi(baseUrl: string, namedTarget = false): OpenClawConfig {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
  return {
    channels: {
      slack: {
        botToken: BOT_TOKEN,
        actions: { messages: true },
        groupPolicy: "allowlist",
        ...(namedTarget
          ? { channels: { "#allowed": { enabled: true } }, dangerouslyAllowNameMatching: true }
          : {}),
      },
    },
  };
}

function sendSlackResponse(response: import("node:http").ServerResponse, payload: object): void {
  response.writeHead(200, { "content-type": "application/json" });
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
    toolContext: {
      currentChannelProvider: "slack",
      currentChannelId: "channel:C_CURRENT",
    },
    assertDirectAdapterHandoff,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearSlackThreadParticipationCache();
});

describe("Slack interactive-action request authority", () => {
  it.each([false, true])(
    "carries authority through permission lookup before a mutation (revoke=%s)",
    async (revokeAfterLookup) => {
      const paths: string[] = [];
      let isLive = true;
      await withServer(
        (request, response) => {
          const path = request.url ?? "";
          paths.push(path);
          request.resume();
          if (path === "/api/conversations.info") {
            if (revokeAfterLookup) {
              isLive = false;
            }
            sendSlackResponse(response, {
              ok: true,
              channel: { id: "C_TARGET", name: "allowed" },
            });
          } else {
            sendSlackResponse(response, {
              ok: true,
              channel: "C_TARGET",
              ts: "171234.1",
            });
          }
        },
        async (baseUrl) => {
          const action = interactiveAction(
            useSlackApi(baseUrl, true),
            "edit",
            {
              channelId: "C_TARGET",
              messageId: "171234.1",
              message: "Updated",
            },
            () => {
              if (!isLive) {
                throw new Error("interactive action is no longer active");
              }
            },
          );
          if (revokeAfterLookup) {
            await expect(action).rejects.toThrow("interactive action is no longer active");
            expect(paths).toEqual(["/api/conversations.info"]);
          } else {
            await expect(action).resolves.toMatchObject({ details: { ok: true } });
            expect(paths).toEqual(["/api/conversations.info", "/api/chat.update"]);
          }
        },
      );
    },
  );

  it("rechecks authority before a target-lookup retry", async () => {
    const paths: string[] = [];
    let isLive = true;
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        isLive = false;
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0",
        });
        response.end(JSON.stringify({ ok: false, error: "ratelimited" }));
      },
      async (baseUrl) => {
        await expect(
          interactiveAction(
            useSlackApi(baseUrl, true),
            "edit",
            {
              channelId: "C_RETRY",
              messageId: "171234.2",
              message: "Updated",
            },
            () => {
              if (!isLive) {
                throw new Error("interactive action is no longer active");
              }
            },
          ),
        ).rejects.toThrow("interactive action is no longer active");
        expect(paths).toEqual(["/api/conversations.info"]);
      },
    );
  });

  it("keeps an accepted mutation and later ordinary action independent", async () => {
    const paths: string[] = [];
    let isLive = true;
    await withServer(
      (request, response) => {
        paths.push(request.url ?? "");
        request.resume();
        isLive = false;
        sendSlackResponse(response, {
          ok: true,
          channel: "C_CURRENT",
          ts: `171234.${String(paths.length)}`,
        });
      },
      async (baseUrl) => {
        const cfg = useSlackApi(baseUrl);
        await expect(
          interactiveAction(cfg, "send", { to: "C_CURRENT", message: "accepted" }, () => {
            if (!isLive) {
              throw new Error("interactive action is no longer active");
            }
          }),
        ).resolves.toMatchObject({ details: { ok: true } });
        await expect(
          interactiveAction(cfg, "send", { to: "C_CURRENT", message: "ordinary" }),
        ).resolves.toMatchObject({ details: { ok: true } });
        expect(paths).toEqual(["/api/chat.postMessage", "/api/chat.postMessage"]);
      },
    );
  });
});
