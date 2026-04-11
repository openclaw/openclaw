import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveWebhooksPluginConfig, resolveWebhooksPluginConfigSync } from "./config.js";

describe("resolveWebhooksPluginConfig", () => {
  it("resolves default paths and SecretRef-backed secrets", async () => {
    const routes = await resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          zapier: {
            sessionKey: "agent:main:main",
            secret: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_WEBHOOK_SECRET",
            },
          },
        },
      },
      cfg: {} as OpenClawConfig,
      env: {
        OPENCLAW_WEBHOOK_SECRET: "shared-secret",
      },
    });

    expect(routes).toEqual([
      {
        routeId: "zapier",
        path: "/plugins/webhooks/zapier",
        sessionKey: "agent:main:main",
        secret: "shared-secret",
        controllerId: "webhooks/zapier",
      },
    ]);
  });

  it("skips routes whose secret cannot be resolved", async () => {
    const warn = vi.fn();

    const routes = await resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          missing: {
            sessionKey: "agent:main:main",
            secret: {
              source: "env",
              provider: "default",
              id: "MISSING_SECRET",
            },
          },
        },
      },
      cfg: {} as OpenClawConfig,
      env: {},
      logger: { warn } as never,
    });

    expect(routes).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[webhooks] skipping route missing:"),
    );
  });

  it("rejects duplicate normalized paths", async () => {
    await expect(
      resolveWebhooksPluginConfig({
        pluginConfig: {
          routes: {
            first: {
              path: "/plugins/webhooks/shared",
              sessionKey: "agent:main:main",
              secret: "a",
            },
            second: {
              path: "/plugins/webhooks/shared/",
              sessionKey: "agent:main:other",
              secret: "b",
            },
          },
        },
        cfg: {} as OpenClawConfig,
        env: {},
      }),
    ).rejects.toThrow(/conflicts with routes\.first\.path/i);
  });

  it("resolves inline string secrets synchronously", () => {
    const routes = resolveWebhooksPluginConfigSync({
      pluginConfig: {
        routes: {
          visionclaw: {
            sessionKey: "agent:main:main",
            secret: "shared-secret",
          },
        },
      },
    });

    expect(routes).toEqual([
      {
        routeId: "visionclaw",
        path: "/plugins/webhooks/visionclaw",
        sessionKey: "agent:main:main",
        secret: "shared-secret",
        controllerId: "webhooks/visionclaw",
      },
    ]);
  });

  it("returns null from the sync resolver when a route secret needs async resolution", () => {
    const routes = resolveWebhooksPluginConfigSync({
      pluginConfig: {
        routes: {
          visionclaw: {
            sessionKey: "agent:main:main",
            secret: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_WEBHOOK_SECRET",
            },
          },
        },
      },
    });

    expect(routes).toBeNull();
  });
});
