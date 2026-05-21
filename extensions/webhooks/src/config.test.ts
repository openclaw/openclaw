import { describe, expect, it } from "vitest";
import { resolveWebhooksPluginConfig } from "./config.js";

describe("resolveWebhooksPluginConfig", () => {
  it("keeps SecretRef-backed secrets on the route config", () => {
    const routes = resolveWebhooksPluginConfig({
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
    });

    expect(routes).toEqual([
      {
        routeId: "zapier",
        path: "/plugins/webhooks/zapier",
        sessionKey: "agent:main:main",
        secret: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_WEBHOOK_SECRET",
        },
        auth: {
          mode: "bearer",
          secret: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_WEBHOOK_SECRET",
          },
          prefix: "Bearer",
          legacySharedHeader: true,
        },
        dispatchMode: "taskflow",
        event: {},
        controllerId: "webhooks/zapier",
      },
    ]);
  });

  it("keeps routes whose secret needs runtime resolution", () => {
    const routes = resolveWebhooksPluginConfig({
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
    });

    expect(routes).toEqual([
      {
        routeId: "missing",
        path: "/plugins/webhooks/missing",
        sessionKey: "agent:main:main",
        secret: {
          source: "env",
          provider: "default",
          id: "MISSING_SECRET",
        },
        auth: {
          mode: "bearer",
          secret: {
            source: "env",
            provider: "default",
            id: "MISSING_SECRET",
          },
          prefix: "Bearer",
          legacySharedHeader: true,
        },
        dispatchMode: "taskflow",
        event: {},
        controllerId: "webhooks/missing",
      },
    ]);
  });

  it("keeps ack routes without TaskFlow session binding", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          alerts: {
            path: "/plugins/webhooks/alerts",
            dispatch: { mode: "ack" },
            auth: {
              mode: "header",
              header: "x-alert-token",
              secret: "shared-secret",
            },
            event: {
              header: "x-alert-event",
              payloadPath: "event.type",
            },
            events: ["incident.created", "incident.updated"],
            idempotency: {
              header: "x-alert-delivery",
              ttlHours: 2,
            },
          },
        },
      },
    });

    expect(routes).toEqual([
      {
        routeId: "alerts",
        path: "/plugins/webhooks/alerts",
        dispatchMode: "ack",
        auth: {
          mode: "header",
          header: "x-alert-token",
          secret: "shared-secret",
        },
        event: {
          header: "x-alert-event",
          payloadPath: "event.type",
        },
        events: ["incident.created", "incident.updated"],
        idempotency: {
          header: "x-alert-delivery",
          ttlMs: 2 * 60 * 60 * 1000,
        },
      },
    ]);
  });

  it("normalizes hmac routes", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          github: {
            dispatch: { mode: "ack" },
            auth: {
              mode: "hmac-sha256",
              header: "x-hub-signature-256",
              prefix: "sha256=",
              secret: {
                source: "env",
                provider: "default",
                id: "GITHUB_WEBHOOK_SECRET",
              },
            },
            idempotency: {
              payloadPath: "delivery.id",
            },
          },
        },
      },
    });

    expect(routes[0]).toMatchObject({
      routeId: "github",
      path: "/plugins/webhooks/github",
      dispatchMode: "ack",
      auth: {
        mode: "hmac-sha256",
        header: "x-hub-signature-256",
        prefix: "sha256=",
        secret: {
          source: "env",
          provider: "default",
          id: "GITHUB_WEBHOOK_SECRET",
        },
      },
      event: {},
      idempotency: {
        payloadPath: "delivery.id",
        ttlMs: 24 * 60 * 60 * 1000,
      },
    });
  });

  it("rejects duplicate normalized paths", () => {
    expect(() =>
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
      }),
    ).toThrow(/conflicts with routes\.first\.path/i);
  });
});
