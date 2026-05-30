---
summary: "Webhooks plugin: authenticated ingress for enterprise systems and SaaS automation"
read_when:
  - You want to trigger an OpenClaw agent from an external application webhook
  - You want to transform arbitrary JSON into an agent prompt, TaskFlow, or channel delivery
  - You are configuring the bundled Webhooks plugin
title: "Webhooks plugin"
---

The Webhooks plugin exposes authenticated HTTP routes inside the Gateway. Use it
to let a trusted SaaS product, CI job, internal service, or enterprise
application send JSON events into OpenClaw without writing a custom plugin.

The recommended enterprise path is: authenticate the sender, filter event types,
deduplicate retries, render the JSON payload into a prompt, and dispatch that
prompt to an agent, TaskFlow, or chat channel.

## Where it runs

The plugin runs inside the Gateway process. If your Gateway runs on another
machine, configure the plugin on that Gateway host and restart the Gateway.

The `openclaw webhooks` CLI manages dynamic subscriptions through the Gateway
WebSocket/RPC control plane. That WebSocket is not the provider delivery path:
GitHub, Codebase, Meego, and other systems still send normal HTTP `POST`
requests to the route URL.

Only expose the specific webhook paths you need. Keep the dashboard and other
Gateway surfaces private behind loopback, a tailnet, or a trusted reverse proxy.

## Choose a dispatch mode

Each route has one dispatch mode:

- `agent`: render the webhook payload into a prompt and schedule one agent turn
  in the configured `sessionKey`. This is the recommended mode for self-built
  enterprise systems.
- `taskflow`: either render the payload into a managed TaskFlow, or use the
  legacy TaskFlow `action` API when no prompt or TaskFlow template is configured.
- `deliver`: render the payload into a direct channel message, or log it.
- `ack`: authenticate, filter, deduplicate, and acknowledge without side
  effects. Use this while testing a new sender.

The default is `taskflow` for compatibility with older `sessionKey` plus
`secret` routes.

## Configure an agent route

This route turns any JSON payload into one agent turn:

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
              sessionKey: "agent:main:main",
              auth: {
                mode: "bearer",
                secret: {
                  source: "env",
                  provider: "default",
                  id: "INCIDENT_WEBHOOK_TOKEN",
                },
              },
              dispatch: {
                mode: "agent",
                agent: {
                  deliveryMode: "announce",
                  nameTemplate: "incident-{incident.id}",
                  tagTemplate: "incident-{incident.id}",
                },
              },
              event: {
                payloadPath: "event.type",
              },
              events: ["incident.created", "incident.updated"],
              idempotency: {
                payloadPath: "delivery.id",
                ttlHours: 24,
              },
              prompt: "Triage incident {incident.id}: {incident.title}\n\nPayload:\n{__raw__}",
              skills: ["incident-response"],
            },
          },
        },
      },
    },
  },
}
```

Test it:

```bash
curl -X POST https://gateway.example.com/plugins/webhooks/incidents \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <INCIDENT_WEBHOOK_TOKEN>' \
  -d '{"delivery":{"id":"evt_123"},"event":{"type":"incident.created"},"incident":{"id":"INC-42","title":"Checkout errors"}}'
```

Accepted requests return `202` with the scheduled job id:

```json
{
  "ok": true,
  "routeId": "incidents",
  "result": {
    "action": "agent_dispatch",
    "sessionKey": "agent:main:main",
    "jobId": "job_123"
  }
}
```

## Template payloads

Templates can reference JSON body fields, headers, route metadata, event type,
and idempotency keys.

Supported forms:

- `{incident.id}`: body path shorthand
- `{payload.incident.id}` or `{body.incident.id}`: explicit body path
- `{headers.x-github-event}` or `{header.x-github-event}`: request header
- `{eventType}`: resolved event type
- `{idempotencyKey}`: resolved delivery id
- `{__raw__}`: stable JSON rendering of the request body, capped for prompts
- `{{json body}}`: stable JSON rendering with double-brace syntax

Single-brace placeholders keep the original literal when the path is missing.
Double-brace placeholders render missing values as an empty string. This makes
Hermes-style templates usable while preserving older OpenClaw template behavior.

## Authentication

Every route must configure either legacy `secret` or explicit `auth`.

```json5
{
  auth: {
    mode: "bearer",
    secret: { source: "env", provider: "default", id: "WEBHOOK_TOKEN" },
  },
}
```

Modes:

- `bearer`: read `Authorization: Bearer <secret>` by default. `auth.prefix`
  changes the accepted prefix.
- `header`: read a custom header configured by `auth.header`.
- `hmac-sha256`: compute `HMAC-SHA256(secret, raw request body)` and compare it
  to `auth.header` after stripping `auth.prefix`, if present.

Legacy routes can still use:

```json5
{
  sessionKey: "agent:main:main",
  secret: { source: "env", provider: "default", id: "OPENCLAW_WEBHOOK_SECRET" },
}
```

That accepts `Authorization: Bearer <secret>` or
`x-openclaw-webhook-secret: <secret>`.

## Event filtering and idempotency

Use `events` to allow only selected event types. Configure `event.header` or
`event.payloadPath` when the sender uses custom names.

If `event` is omitted, the plugin also checks common headers and body paths such
as `x-github-event`, `x-event-type`, `event.type`, `event_type`, and `type`.

Use `idempotency` with a delivery id from the source system:

```json5
{
  idempotency: {
    header: "x-request-id",
    payloadPath: "delivery.id",
    ttlHours: 24,
  },
}
```

When plugin state storage is available, idempotency keys are stored in the
Gateway's persistent plugin state store. If that store is unavailable, the
plugin falls back to in-process dedupe for the same TTL.

Duplicate requests are acknowledged without repeating side effects:

```json
{
  "ok": true,
  "routeId": "incidents",
  "duplicate": true,
  "idempotencyKey": "evt_123"
}
```

## Direct channel delivery

Use `deliver` when a webhook should notify a channel without running an agent:

```json5
{
  routes: {
    alerts: {
      dispatch: { mode: "deliver" },
      auth: {
        mode: "header",
        header: "x-alert-token",
        secret: { source: "env", provider: "default", id: "ALERT_WEBHOOK_TOKEN" },
      },
      prompt: "Alert {alert.id}: {alert.summary}",
      deliver: {
        channel: "telegram",
        to: "{alert.chat_id}",
        threadId: "{alert.topic_id}",
        textTemplate: "Escalate {alert.id}: {alert.summary}",
        silent: true,
      },
    },
  },
}
```

Hermes-style delivery is also accepted:

```json5
{
  deliver_only: true,
  deliver: "telegram",
  deliver_extra: {
    chat_id: "{alert.chat_id}",
    message_thread_id: "{alert.topic_id}",
    silent: true,
  },
  prompt: "Alert {alert.id}: {alert.summary}",
}
```

`deliver: "log"` records the rendered prompt in Gateway logs and performs no
channel send.

If `deliver` names a channel and `deliver_extra.chat_id` or `deliver.to` is
omitted, OpenClaw asks that channel adapter for its default outbound target. If
the channel has no configured default target, the route returns `400` instead of
guessing.

## TaskFlow dispatch

Use templated TaskFlow dispatch when a webhook should create durable workflow
state before an agent or worker acts on it:

```json5
{
  routes: {
    jira: {
      sessionKey: "agent:main:main",
      auth: {
        mode: "bearer",
        secret: { source: "env", provider: "default", id: "JIRA_WEBHOOK_TOKEN" },
      },
      dispatch: {
        mode: "taskflow",
        taskflow: {
          goalTemplate: "Investigate {issue.key}: {issue.fields.summary}",
          currentStep: "queued from Jira webhook",
          status: "queued",
          notifyPolicy: "state_changes",
          runTask: {
            runtime: "acp",
            taskTemplate: "Start triage for {issue.key}. Full payload:\n{__raw__}",
            runIdTemplate: "{webhookEvent.id}",
            labelTemplate: "{issue.key}",
          },
        },
      },
      idempotency: {
        payloadPath: "webhookEvent.id",
      },
    },
  },
}
```

If `dispatch.mode` is `taskflow` and the route has either `prompt` or
`dispatch.taskflow`, arbitrary JSON payloads are accepted and turned into a
managed TaskFlow. The original payload is stored in the flow state under
`payload`.

If neither `prompt` nor `dispatch.taskflow` is configured, `taskflow` mode uses
the legacy action API below.

## Legacy TaskFlow action API

Legacy TaskFlow routes accept JSON bodies with an explicit `action` field:

```bash
curl -X POST https://gateway.example.com/plugins/webhooks/zapier \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <OPENCLAW_WEBHOOK_SECRET>' \
  -d '{"action":"create_flow","goal":"Review inbound queue"}'
```

Supported actions:

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

`run_task` supports `runtime: "acp"` and `runtime: "subagent"` for legacy
callers. New templated TaskFlow routes use `acp`.

## Enterprise integration flow

For a self-built enterprise application:

1. Create one route per application or event family.
2. Store the route secret in an environment variable, file, or exec-backed
   SecretRef.
3. Configure the application to send `POST` JSON to the route path with the
   selected auth header.
4. Put the source event type in a header or stable JSON path and allowlist it
   with `events`.
5. Put the source delivery id in `idempotency.header` or
   `idempotency.payloadPath`.
6. Write a `prompt` or `dispatch.agent.messageTemplate` that tells the agent
   what decision or action to take.
7. Send a sample event with `curl`, then verify the `202` response, Gateway
   logs, and the target session or channel.

OpenClaw does not make every arbitrary enterprise system correct by default.
The integration is simple when the source can send HTTPS JSON and provide a
stable auth secret plus delivery id. Systems without outbound webhooks, stable
event identifiers, or reachable network access still need an adapter, polling
job, or gateway-side connector.

## Dynamic subscriptions

Static routes are best when you want reviewable config, SecretRefs, and
environment-specific rollout. Dynamic subscriptions are useful for experiments
and operator-managed routes that should be created without editing config:

```bash
openclaw webhooks subscribe github-pr-review \
  --agent-id webhook-reviewer \
  --session-key github/pr-review \
  --event-header x-github-event \
  --events pull_request,pull_request_review \
  --idempotency-header x-github-delivery \
  --prompt 'Review GitHub PR {{body.pull_request.html_url}}. Payload: {{__raw__}}'
```

The command returns the subscription path, generated HMAC secret, and a full
`webhookUrl` when `plugins.entries.webhooks.config.publicUrl` is set:

```json5
{
  plugins: {
    entries: {
      webhooks: {
        enabled: true,
        config: {
          publicUrl: "https://gateway.example.com",
          routes: {},
        },
      },
    },
  },
}
```

`publicUrl` only affects CLI output. It does not open a network path. The source
system must still be able to reach the HTTP route through public HTTPS, private
ingress, an enterprise gateway, or a temporary development tunnel.

## Best practices

- Use one secret per route. Rotate it in the source system and SecretRef
  together.
- Always configure idempotency for systems that retry webhooks. Use the source
  delivery id, not a hash of the whole payload.
- For providers that verify webhook URLs with a challenge payload, add
  `verification`. Challenge requests are answered only after route-specific auth
  succeeds and are not dispatched to an agent or TaskFlow.
- Start in `ack` or `deliver: "log"` mode, capture real payloads, then switch to
  `agent` or templated `taskflow` after the prompt is stable.
- Keep prompts explicit about authority. Tell the agent whether it should only
  summarize, create a draft, open a TaskFlow, or take action through tools.
- Bind `agent` and `taskflow` routes to the narrowest useful `sessionKey`.
- Treat webhook payloads as untrusted input. Do not copy secrets, tokens, or
  customer-private blobs into prompts unless the agent needs them.
- Put event allowlists on every high-volume route so unrelated events are
  acknowledged without invoking an agent.
- Use `deliveryMode: "none"` for silent back-office workflows and `announce`
  only when the session should see scheduled work.
- Keep route paths stable. If you rename a path, update the source system and
  keep the old route in `ack` mode during cutover when possible.
- Monitor `401`, `400`, `409`, `502`, and `503` responses. These distinguish
  auth failures, invalid targets, workflow conflicts, downstream delivery
  failures, and runtime unavailability.

## Response shape

Successful responses return:

```json
{
  "ok": true,
  "routeId": "incidents",
  "result": {}
}
```

Rejected requests return:

```json
{
  "ok": false,
  "routeId": "incidents",
  "code": "invalid_delivery_target",
  "error": "Delivery target rendered to an empty value."
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

The plugin intentionally scrubs owner/session metadata from TaskFlow webhook
responses.

## Related docs

- [Enterprise webhook integrations](/plugins/webhooks-enterprise-integrations)
- [Enterprise webhook validation and deployment](/plugins/webhooks-enterprise-validation)
- [Plugin runtime SDK](/plugins/sdk-runtime)
- [Hooks and webhooks overview](/automation/hooks)
- [CLI webhooks](/cli/webhooks)
