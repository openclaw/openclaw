---
summary: "Webhooks plugin: authenticated ingress for trusted external automation"
read_when:
  - You want to trigger or drive TaskFlows from an external system
  - You want to acknowledge and filter inbound webhook events before deeper automation exists
  - You are configuring the bundled webhooks plugin
title: "Webhooks plugin"
---

The Webhooks plugin adds authenticated HTTP routes for trusted external
automation.

Use it when you want a trusted system such as Zapier, n8n, a CI job, or an
internal service to send events into OpenClaw without writing a custom plugin
first.

## Where it runs

The Webhooks plugin runs inside the Gateway process.

If your Gateway runs on another machine, install and configure the plugin on
that Gateway host, then restart the Gateway.

## Choose a dispatch mode

Each route has a dispatch mode:

- `ack`: authenticate the request, optionally filter by event type, optionally
  deduplicate by an idempotency key, and return an acknowledgement. This is the
  recommended first step for connecting a new enterprise system.
- `taskflow`: authenticate the request and execute the existing TaskFlow
  webhook action API for the configured `sessionKey`.

The default is `taskflow` for backwards compatibility with earlier
`sessionKey` plus `secret` routes.

## Configure TaskFlow routes

Set config under `plugins.entries.webhooks.config`:

```json5
{
  plugins: {
    entries: {
      webhooks: {
        enabled: true,
        config: {
          routes: {
            zapier: {
              path: "/plugins/webhooks/zapier",
              sessionKey: "agent:main:main",
              secret: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_WEBHOOK_SECRET",
              },
              controllerId: "webhooks/zapier",
              description: "Zapier TaskFlow bridge",
            },
          },
        },
      },
    },
  },
}
```

Route fields:

- `enabled`: optional, defaults to `true`
- `path`: optional, defaults to `/plugins/webhooks/<routeId>`
- `dispatch.mode`: optional, defaults to `taskflow`
- `sessionKey`: required for `taskflow`; session that owns the bound TaskFlows
- `secret`: shared secret or SecretRef for legacy bearer/header auth
- `controllerId`: optional controller id for created managed flows
- `description`: optional operator note

Supported `secret` inputs:

- Plain string
- SecretRef with `source: "env" | "file" | "exec"`

SecretRef values are resolved for each request. If the current secret cannot be
resolved or does not match the presented value, the request is rejected with
`401 unauthorized`.

## Configure ack routes

Use `ack` mode when you first connect a SaaS or internal application and need a
safe receiving endpoint before mapping the event to an agent workflow.

```json5
{
  plugins: {
    entries: {
      webhooks: {
        enabled: true,
        config: {
          routes: {
            incidents: {
              path: "/plugins/webhooks/incidents",
              dispatch: { mode: "ack" },
              auth: {
                mode: "header",
                header: "x-incident-token",
                secret: {
                  source: "env",
                  provider: "default",
                  id: "INCIDENT_WEBHOOK_TOKEN",
                },
              },
              event: {
                header: "x-incident-event",
                payloadPath: "event.type",
              },
              events: ["incident.created", "incident.updated"],
              idempotency: {
                header: "x-incident-delivery",
                payloadPath: "delivery.id",
                ttlHours: 24,
              },
            },
          },
        },
      },
    },
  },
}
```

Ack route fields:

- `auth.mode`: `bearer`, `header`, or `hmac-sha256`
- `auth.secret`: shared secret or SecretRef
- `auth.header`: required for `header` and `hmac-sha256`
- `auth.prefix`: optional prefix stripped from the presented header value; for
  example `sha256=` for GitHub-style HMAC signatures
- `event.header`: optional event type header
- `event.payloadPath`: optional dot path to the event type inside the JSON body
- `events`: optional allowlist of event types to process
- `idempotency.header`: optional delivery id header
- `idempotency.payloadPath`: optional dot path to the delivery id inside the JSON body
- `idempotency.ttlHours`: optional in-process duplicate window; defaults to 24
  hours when idempotency is enabled

When both an event header and payload path are configured, the header wins. When
both an idempotency header and payload path are configured, the header wins.

This first ack implementation stores idempotency keys in Gateway process memory.
It protects common retry bursts, but keys do not survive a Gateway restart or
multi-process deployment. Use source-system delivery IDs so a later durable
store can preserve the same contract.

## Security model

TaskFlow routes are trusted to act with the TaskFlow authority of their
configured `sessionKey`. Ack routes authenticate and acknowledge requests
without binding a TaskFlow session.

This means a TaskFlow route can inspect and mutate TaskFlows owned by that
session, so you should:

- Use a strong unique secret per route
- Prefer secret references over inline plaintext secrets
- Bind routes to the narrowest session that fits the workflow
- Expose only the specific webhook path you need

The plugin applies:

- Shared-secret authentication
- Optional HMAC-SHA256 raw-body verification
- Optional event allowlisting
- Optional in-process idempotency for ack routes
- Request body size and timeout guards
- Fixed-window rate limiting
- In-flight request limiting
- Owner-bound TaskFlow access through `api.runtime.tasks.managedFlows.bindSession(...)`
  for `taskflow` routes

## Request format

Send `POST` requests with:

- `Content-Type: application/json`
- `Authorization: Bearer <secret>` or `x-openclaw-webhook-secret: <secret>`

Example:

```bash
curl -X POST https://gateway.example.com/plugins/webhooks/zapier \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_SHARED_SECRET' \
  -d '{"action":"create_flow","goal":"Review inbound queue"}'
```

Header-auth ack example:

```bash
curl -X POST https://gateway.example.com/plugins/webhooks/incidents \
  -H 'Content-Type: application/json' \
  -H 'x-incident-token: YOUR_SHARED_SECRET' \
  -H 'x-incident-event: incident.created' \
  -H 'x-incident-delivery: evt_123' \
  -d '{"event":{"type":"incident.created"},"delivery":{"id":"evt_123"}}'
```

HMAC routes compute `HMAC-SHA256(secret, raw request body)` and compare it to
the configured signature header after removing `auth.prefix`, if present.

## Supported actions

The plugin currently accepts these JSON `action` values:

- `create_flow`
- `get_flow`
- `list_flows`
- `find_latest_flow`
- `resolve_flow`
- `get_task_summary`
- `set_waiting`
- `resume_flow`
- `finish_flow`
- `fail_flow`
- `request_cancel`
- `cancel_flow`
- `run_task`

### `create_flow`

Creates a managed TaskFlow for the route's bound session.

Example:

```json
{
  "action": "create_flow",
  "goal": "Review inbound queue",
  "status": "queued",
  "notifyPolicy": "done_only"
}
```

### `run_task`

Creates a managed child task inside an existing managed TaskFlow.

Allowed runtimes are:

- `subagent`
- `acp`

Example:

```json
{
  "action": "run_task",
  "flowId": "flow_123",
  "runtime": "acp",
  "childSessionKey": "agent:main:acp:worker",
  "task": "Inspect the next message batch"
}
```

## Response shape

Successful responses return:

```json
{
  "ok": true,
  "routeId": "zapier",
  "result": {}
}
```

Rejected requests return:

```json
{
  "ok": false,
  "routeId": "zapier",
  "code": "not_found",
  "error": "TaskFlow not found.",
  "result": {}
}
```

The plugin intentionally scrubs owner/session metadata from webhook responses.

Ack routes return:

```json
{
  "ok": true,
  "routeId": "incidents",
  "result": {
    "action": "ack",
    "eventType": "incident.created",
    "idempotencyKey": "evt_123"
  }
}
```

Filtered events are acknowledged without side effects:

```json
{
  "ok": true,
  "routeId": "incidents",
  "skipped": true,
  "reason": "event_not_allowed",
  "eventType": "incident.closed"
}
```

Duplicate ack events return:

```json
{
  "ok": true,
  "routeId": "incidents",
  "duplicate": true,
  "idempotencyKey": "evt_123"
}
```

## Related docs

- [Plugin runtime SDK](/plugins/sdk-runtime)
- [Hooks and webhooks overview](/automation/hooks)
- [CLI webhooks](/cli/webhooks)
