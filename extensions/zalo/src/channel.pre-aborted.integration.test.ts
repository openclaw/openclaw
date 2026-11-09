import {
  createEmptyPluginRegistry,
  createStartAccountContext,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setZaloRuntime } from "../runtime-api.js";
import { resolveZaloAccount } from "./accounts.js";
import { zaloPlugin } from "./channel.js";

describe("configured Zalo gateway with a pre-aborted lifecycle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each([
    { mode: "polling", channel: { botToken: "test-bot-token" } },
    {
      mode: "webhook",
      channel: {
        botToken: "test-bot-token",
        webhookUrl: "https://example.invalid/hooks/zalo",
        webhookSecret: "test-webhook-secret",
      },
    },
  ] as const)("performs only the account probe in $mode mode", async ({ channel }) => {
    const apiMethods: string[] = [];
    await withServer(
      (request, response) => {
        const method = request.url?.match(/\/bot[^/]+\/([^/?]+)/u)?.[1] ?? "unknown";
        apiMethods.push(method);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            result:
              method === "getMe"
                ? {
                    id: "loopback-bot",
                    account_name: "Loopback proof bot",
                    account_type: "BOT",
                    can_join_groups: false,
                  }
                : { url: "" },
          }),
        );
      },
      async (baseUrl) => {
        vi.stubEnv("ZALO_API_URL", baseUrl);
        setZaloRuntime({} as PluginRuntime);
        const registry = createEmptyPluginRegistry();
        setActivePluginRegistry(registry);
        const cfg = { channels: { zalo: channel } };
        const abort = new AbortController();
        abort.abort();
        const startAccount = zaloPlugin.gateway?.startAccount;
        if (!startAccount) {
          throw new Error("expected Zalo gateway startAccount");
        }
        await startAccount(
          createStartAccountContext({
            account: resolveZaloAccount({ cfg }),
            cfg,
            abortSignal: abort.signal,
          }),
        );
        expect(apiMethods).toEqual(["getMe"]);
        expect(registry.httpRoutes).toHaveLength(0);
      },
    );
  });
});
