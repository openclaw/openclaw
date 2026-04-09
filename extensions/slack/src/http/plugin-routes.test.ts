import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { registerSlackPluginHttpRoutes } from "./plugin-routes.js";

type RegisterHttpRouteCall = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];

function makeMockApi(cfg: Record<string, unknown>): {
  api: OpenClawPluginApi;
  registerHttpRoute: ReturnType<typeof vi.fn<[RegisterHttpRouteCall], void>>;
} {
  const registerHttpRoute = vi.fn<[RegisterHttpRouteCall], void>();
  const api = {
    config: cfg,
    registerHttpRoute,
  } as unknown as OpenClawPluginApi;
  return { api, registerHttpRoute };
}

describe("registerSlackPluginHttpRoutes (#63937)", () => {
  it("registers the default webhook path when slack config is absent", () => {
    const { api, registerHttpRoute } = makeMockApi({});

    expect(() => registerSlackPluginHttpRoutes(api)).not.toThrow();
    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute.mock.calls[0]?.[0]).toMatchObject({
      path: "/slack/events",
      auth: "plugin",
    });
  });

  it("does not resolve SecretRef tokens at register time (#63937)", () => {
    // Regression: previously `registerSlackPluginHttpRoutes` called
    // `resolveSlackAccount`, which eagerly ran `resolveSlackBotToken`
    // on the merged config. When `botToken` is a `SecretRef` object
    // (e.g. `file:local:/SLACK_BOT_TOKEN`) and the caller is the CLI
    // (no gateway runtime snapshot), that threw "unresolved SecretRef"
    // and crashed every `openclaw agents` subcommand. The fix swaps
    // to the token-free `mergeSlackAccountConfig` helper.
    const { api, registerHttpRoute } = makeMockApi({
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: {
                source: "file",
                provider: "local",
                id: "/SLACK_BOT_TOKEN",
              },
              appToken: {
                source: "file",
                provider: "local",
                id: "/SLACK_APP_TOKEN",
              },
            },
          },
        },
      },
    });

    expect(() => registerSlackPluginHttpRoutes(api)).not.toThrow();
    expect(registerHttpRoute).toHaveBeenCalled();
    expect(registerHttpRoute.mock.calls[0]?.[0]?.path).toBe("/slack/events");
  });

  it("registers a custom webhookPath from config without touching tokens", () => {
    const { api, registerHttpRoute } = makeMockApi({
      channels: {
        slack: {
          accounts: {
            default: {
              webhookPath: "/hooks/slack",
              botToken: {
                source: "file",
                provider: "local",
                id: "/SLACK_BOT_TOKEN",
              },
            },
          },
        },
      },
    });

    expect(() => registerSlackPluginHttpRoutes(api)).not.toThrow();
    const paths = registerHttpRoute.mock.calls.map((call) => call[0]?.path);
    expect(paths).toContain("/hooks/slack");
  });

  it("deduplicates webhook paths across multiple accounts with the same path", () => {
    const { api, registerHttpRoute } = makeMockApi({
      channels: {
        slack: {
          accounts: {
            default: { webhookPath: "/slack/events" },
            secondary: { webhookPath: "/slack/events" },
          },
        },
      },
    });

    expect(() => registerSlackPluginHttpRoutes(api)).not.toThrow();
    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
  });
});
