---
summary: "CLI reference for `openclaw webhooks` dynamic subscriptions"
read_when:
  - You want to create or manage Gateway-hosted webhook routes from the CLI
  - You need to test a webhook route through the Gateway control plane
  - You need the full flag list for `openclaw webhooks subscribe`
title: "Webhooks"
---

# `openclaw webhooks`

`openclaw webhooks` manages dynamic routes for the bundled Webhooks plugin.
The CLI talks to the OpenClaw Gateway over the normal Gateway WebSocket/RPC
control plane. External systems still deliver real webhook events with HTTP
`POST` requests to `/plugins/webhooks/<route>`.

Use this command when you want a Hermes-style workflow:

1. Create a named webhook subscription.
2. Copy the returned URL and HMAC secret into the source system.
3. Send a signed test delivery.
4. List or remove the subscription later without editing static config.

## Subcommands

```bash
openclaw webhooks subscribe <name> [flags]
openclaw webhooks list
openclaw webhooks remove <name>
openclaw webhooks test <name> [flags]
```

| Subcommand  | Description                                                                  |
| ----------- | ---------------------------------------------------------------------------- |
| `subscribe` | Create or update a Gateway-managed webhook subscription.                     |
| `list`      | List dynamic webhook subscriptions.                                          |
| `remove`    | Remove a dynamic webhook subscription. Static config routes are not removed. |
| `test`      | Send a signed test delivery through the Gateway method.                      |

## `webhooks subscribe`

Create or update a dynamic subscription. The route is persisted under the
Gateway state directory and hot-loaded by the Webhooks plugin.

```bash
openclaw webhooks subscribe github-pr-review \
  --agent-id webhook-reviewer \
  --session-key github/pr-review \
  --event-header x-github-event \
  --events pull_request,pull_request_review \
  --idempotency-header x-github-delivery \
  --prompt 'Review GitHub PR {{body.pull_request.html_url}}. Payload: {{__raw__}}'
```

By default the command prints a Hermes-style setup summary with the URL, secret,
events, dispatch mode, and provider configuration hint. Pass `--json` when a
script needs the raw Gateway RPC response. The response includes the route path,
a generated HMAC secret, and `webhookUrl` when
`plugins.entries.webhooks.config.publicUrl` is configured:

```json
{
  "subscription": {
    "name": "github-pr-review",
    "path": "/plugins/webhooks/github-pr-review"
  },
  "secret": "<generated-hmac-secret>",
  "webhookUrl": "https://gateway.example.com/plugins/webhooks/github-pr-review"
}
```

### Flags

| Flag                                | Description                                                         |
| ----------------------------------- | ------------------------------------------------------------------- |
| `--path <path>`                     | Explicit webhook HTTP path. Defaults to `/plugins/webhooks/<name>`. |
| `--session-key <key>`               | OpenClaw session key used for agent dispatch.                       |
| `--agent-id <id>`                   | Agent id for agent dispatch.                                        |
| `--dispatch-mode <mode>`            | `agent` or `ack`. Defaults to `agent`.                              |
| `--delivery-mode <mode>`            | Agent delivery mode, `none` or `announce`. Defaults to `none`.      |
| `--prompt <template>`               | Prompt/message template.                                            |
| `--message-template <template>`     | Alias for the agent message template.                               |
| `--events <csv>`                    | Event allowlist.                                                    |
| `--event-header <header>`           | Header that contains the event type.                                |
| `--event-payload-path <path>`       | Payload path that contains the event type.                          |
| `--idempotency-header <header>`     | Header that contains the delivery id.                               |
| `--idempotency-payload-path <path>` | Payload path that contains the delivery id.                         |
| `--idempotency-ttl-hours <hours>`   | Duplicate delivery retention window.                                |
| `--skills <csv>`                    | Skills to include in dispatch context.                              |
| `--description <text>`              | Human-readable route description.                                   |
| `--secret <secret>`                 | Explicit HMAC secret. If omitted, OpenClaw generates one.           |
| `--json`                            | Print the raw Gateway RPC response.                                 |

Dynamic subscriptions use HMAC-SHA256 by default:

```text
Header: x-openclaw-webhook-signature-256
Value:  sha256=<hex HMAC of raw request body>
```

## `webhooks list`

```bash
openclaw webhooks list
```

Prints dynamic subscriptions in a readable list. Pass `--json` for the raw
response. Secrets are not printed; the output only shows whether a secret is
configured.

## `webhooks remove`

```bash
openclaw webhooks remove github-pr-review
```

Removes a dynamic subscription by name. Static routes declared in
`openclaw.json` or plugin config remain managed by config. Pass `--json` for
the raw response.

## `webhooks test`

```bash
openclaw webhooks test github-pr-review \
  --event-type pull_request \
  --idempotency-key delivery-test-1 \
  --payload '{"pull_request":{"html_url":"https://github.com/acme/repo/pull/1"}}'
```

`test` signs the payload with the subscription secret and executes the same
handler path that real HTTP deliveries use. It is a control-plane test for route
configuration; it does not prove that GitHub, Codebase, Meego, or another
external system can reach the route. For production proof, create a real object
in the source system and confirm its delivery id, OpenClaw dispatch/run id, and
writeback result. Pass `--json` for the raw response.

## Public URL

Set `plugins.entries.webhooks.config.publicUrl` when the CLI should print full
URLs for new subscriptions:

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

`publicUrl` is only used for CLI output. It does not expose the Gateway by
itself. The configured URL must already be reachable by the source system
through public HTTPS, private ingress, an enterprise API gateway, or a temporary
development tunnel.

## Related

- [Webhooks plugin](/plugins/webhooks)
- [Enterprise webhook validation](/plugins/webhooks-enterprise-validation)
- [Enterprise webhook integrations](/plugins/webhooks-enterprise-integrations)
