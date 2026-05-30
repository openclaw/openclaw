import { describe, expect, it } from "vitest";
import { resolveWebhooksPluginConfig, resolveWebhooksPluginRuntimeConfig } from "./config.js";

describe("resolveWebhooksPluginConfig", () => {
  it("keeps the public URL used for dynamic subscription output", () => {
    const cfg = resolveWebhooksPluginRuntimeConfig({
      pluginConfig: {
        publicUrl: "https://gateway.example.com/base",
      },
    });

    expect(cfg).toEqual({
      publicUrl: "https://gateway.example.com/base",
      routes: [],
    });
  });

  it("rejects WebSocket URLs for webhook public URL output", () => {
    expect(() =>
      resolveWebhooksPluginRuntimeConfig({
        pluginConfig: {
          publicUrl: "wss://gateway.example.com",
        },
      }),
    ).toThrow("publicUrl must be an HTTP(S) URL");
  });

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

  it("normalizes provider URL verification challenge settings", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          meego: {
            path: "/plugins/webhooks/meego-requirement-created",
            dispatch: { mode: "ack" },
            auth: {
              mode: "header",
              header: "x-meego-webhook-token",
              secret: "shared-secret",
            },
            event: {
              payloadPath: "type",
            },
            verification: {
              event: "url_verification",
              challengePath: "challenge",
              responsePath: "challenge",
            },
          },
        },
      },
    });

    expect(routes[0]).toMatchObject({
      routeId: "meego",
      path: "/plugins/webhooks/meego-requirement-created",
      verification: {
        event: "url_verification",
        challengePath: "challenge",
        responsePath: "challenge",
      },
    });
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

  it("normalizes agent dispatch routes with prompt templates and skills", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          pagerduty: {
            sessionKey: "agent:main:main",
            auth: {
              mode: "bearer",
              secret: "agent-secret",
            },
            dispatch: {
              mode: "agent",
              agent: {
                messageTemplate: "Triage incident {incident.id}: {incident.title}",
                deliveryMode: "none",
                delayMs: 50,
                nameTemplate: "incident-{incident.id}",
                tagTemplate: "incident:{incident.id}",
                agentId: "sre-agent",
              },
            },
            skills: ["incident-response"],
          },
        },
      },
    });

    expect(routes).toEqual([
      {
        routeId: "pagerduty",
        path: "/plugins/webhooks/pagerduty",
        dispatchMode: "agent",
        sessionKey: "agent:main:main",
        auth: {
          mode: "bearer",
          secret: "agent-secret",
          prefix: "Bearer",
        },
        event: {},
        skills: ["incident-response"],
        agent: {
          messageTemplate: "Triage incident {incident.id}: {incident.title}",
          deliveryMode: "none",
          delayMs: 50,
          nameTemplate: "incident-{incident.id}",
          tagTemplate: "incident:{incident.id}",
          agentId: "sre-agent",
        },
      },
    ]);
  });

  it("normalizes agent completion delivery routes", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          codebase: {
            sessionKey: "agent:reviewer:codebase",
            auth: {
              mode: "header",
              header: "x-vecode-hook-id",
              secret: "hook-secret",
            },
            dispatch: {
              mode: "agent",
              agent: {
                deliveryMode: "none",
                onCompletion: {
                  deliver: {
                    mode: "channel",
                    channel: "codebase",
                    to: "{Repository.Path}",
                    threadId: "{MergeRequest.Number}",
                    textTemplate: "{completionText}",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(routes[0]).toMatchObject({
      routeId: "codebase",
      dispatchMode: "agent",
      agent: {
        deliveryMode: "none",
        onCompletion: {
          delivery: {
            mode: "channel",
            channel: "codebase",
            to: "{Repository.Path}",
            threadId: "{MergeRequest.Number}",
            textTemplate: "{completionText}",
          },
        },
      },
    });
  });

  it("rejects standalone relay connector config", () => {
    expect(() =>
      resolveWebhooksPluginRuntimeConfig({
        pluginConfig: {
          relay: {
            mode: "websocket",
            url: "wss://relay.example.test/openclaw/webhooks",
          },
          routes: {},
        },
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("normalizes exec completion delivery routes", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          codebase: {
            sessionKey: "agent:reviewer:codebase",
            auth: {
              mode: "header",
              header: "x-vecode-hook-id",
              secret: "hook-secret",
            },
            dispatch: {
              mode: "agent",
              agent: {
                onCompletion: {
                  deliver: {
                    mode: "exec",
                    command: "bytedcli",
                    args: ["--json", "codebase", "mr", "review", "{MergeRequest.Number}"],
                    cwd: "/tmp/repo",
                    textTemplate: "{completionText}",
                    timeoutMs: 10000,
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(routes[0]).toMatchObject({
      dispatchMode: "agent",
      agent: {
        onCompletion: {
          delivery: {
            mode: "exec",
            command: "bytedcli",
            args: ["--json", "codebase", "mr", "review", "{MergeRequest.Number}"],
            cwd: "/tmp/repo",
            textTemplate: "{completionText}",
            timeoutMs: 10000,
          },
        },
      },
    });
  });

  it("normalizes Hermes-style string delivery routes", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          alerts: {
            dispatch: { mode: "deliver" },
            auth: {
              mode: "header",
              header: "x-alert-token",
              secret: "deliver-secret",
            },
            prompt: "Alert {alert.id}: {alert.summary}",
            deliver: "telegram",
            deliver_extra: {
              chat_id: "{alert.chat_id}",
              message_thread_id: "{alert.topic_id}",
              silent: true,
            },
          },
        },
      },
    });

    expect(routes).toEqual([
      {
        routeId: "alerts",
        path: "/plugins/webhooks/alerts",
        dispatchMode: "deliver",
        auth: {
          mode: "header",
          header: "x-alert-token",
          secret: "deliver-secret",
        },
        event: {},
        prompt: "Alert {alert.id}: {alert.summary}",
        delivery: {
          mode: "channel",
          channel: "telegram",
          to: "{alert.chat_id}",
          threadId: "{alert.topic_id}",
          silent: true,
        },
      },
    ]);
  });

  it("allows Hermes-style string delivery routes to use the channel default target", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          alerts: {
            dispatch: { mode: "deliver" },
            auth: {
              mode: "bearer",
              secret: "deliver-secret",
            },
            prompt: "Alert {alert.id}: {alert.summary}",
            deliver: "telegram",
          },
        },
      },
    });

    expect(routes[0]).toMatchObject({
      routeId: "alerts",
      dispatchMode: "deliver",
      delivery: {
        mode: "channel",
        channel: "telegram",
      },
    });
  });

  it("normalizes object delivery routes", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          chatops: {
            deliver_only: true,
            auth: {
              mode: "bearer",
              secret: "deliver-secret",
            },
            deliver: {
              channel: "slack",
              to: "C123",
              accountId: "workspace-a",
              threadId: "{thread.ts}",
              textTemplate: "Build {build.id} finished",
            },
          },
        },
      },
    });

    expect(routes[0]).toMatchObject({
      routeId: "chatops",
      dispatchMode: "deliver",
      delivery: {
        mode: "channel",
        channel: "slack",
        to: "C123",
        accountId: "workspace-a",
        threadId: "{thread.ts}",
        textTemplate: "Build {build.id} finished",
      },
    });
  });

  it("normalizes object delivery routes with Hermes-style extra fields", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          chatops: {
            dispatch: { mode: "deliver" },
            auth: {
              mode: "bearer",
              secret: "deliver-secret",
            },
            deliver: {
              channel: "telegram",
            },
            deliverExtra: {
              chatId: "{chat.id}",
              thread_id: "{message.thread}",
              account_id: "workspace-a",
              silent: false,
            },
          },
        },
      },
    });

    expect(routes[0]).toMatchObject({
      routeId: "chatops",
      dispatchMode: "deliver",
      delivery: {
        mode: "channel",
        channel: "telegram",
        to: "{chat.id}",
        threadId: "{message.thread}",
        accountId: "workspace-a",
        silent: false,
      },
    });
  });

  it("normalizes templated TaskFlow dispatch routes", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          jira: {
            sessionKey: "agent:main:main",
            secret: "taskflow-secret",
            prompt: "Investigate ticket {issue.key}: {issue.summary}",
            dispatch: {
              mode: "taskflow",
              taskflow: {
                goalTemplate: "Ticket {issue.key}",
                currentStep: "queued from Jira",
                status: "queued",
                notifyPolicy: "state_changes",
                runTask: {
                  taskTemplate: "Start on {issue.key}",
                  runIdTemplate: "{webhookEvent.id}",
                  labelTemplate: "{issue.key}",
                  status: "queued",
                  preferMetadata: true,
                },
              },
            },
          },
        },
      },
    });

    expect(routes[0]).toMatchObject({
      routeId: "jira",
      dispatchMode: "taskflow",
      prompt: "Investigate ticket {issue.key}: {issue.summary}",
      taskflow: {
        goalTemplate: "Ticket {issue.key}",
        currentStep: "queued from Jira",
        status: "queued",
        notifyPolicy: "state_changes",
        runTask: {
          enabled: true,
          runtime: "acp",
          taskTemplate: "Start on {issue.key}",
          runIdTemplate: "{webhookEvent.id}",
          labelTemplate: "{issue.key}",
          status: "queued",
          preferMetadata: true,
        },
      },
    });
  });

  it("rejects delivery routes without a delivery target", () => {
    expect(() =>
      resolveWebhooksPluginConfig({
        pluginConfig: {
          routes: {
            broken: {
              dispatch: { mode: "deliver" },
              auth: {
                mode: "bearer",
                secret: "deliver-secret",
              },
            },
          },
        },
      }),
    ).toThrow(/deliver is required/i);
  });

  it("allows duplicate normalized paths for route-specific auth isolation", () => {
    const routes = resolveWebhooksPluginConfig({
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
    });

    expect(routes).toMatchObject([
      {
        routeId: "first",
        path: "/plugins/webhooks/shared",
        sessionKey: "agent:main:main",
      },
      {
        routeId: "second",
        path: "/plugins/webhooks/shared",
        sessionKey: "agent:main:other",
      },
    ]);
  });
});
