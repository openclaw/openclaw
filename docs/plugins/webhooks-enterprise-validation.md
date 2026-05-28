---
summary: "Review verified enterprise webhook scenarios and choose a deployment pattern"
read_when:
  - You want the validation evidence for the Webhooks plugin enterprise integration examples
  - You need to decide whether a webhook route needs a tunnel, reverse proxy, private load balancer, or relay
  - You want to compare webhook ingress with a Janus-style browser connector
title: "Enterprise webhook validation and deployment"
---

The Webhooks plugin lets enterprise systems trigger OpenClaw through
authenticated HTTP routes. This page records the validation coverage for common
application patterns, compares the implementation with adjacent agent systems,
explains how those applications should connect, and clarifies when a public
ingress path is required.

The short version: the sender must be able to reach the specific webhook URL.
That URL can be public HTTPS, private VPC HTTPS, localhost, or a relay endpoint.
It does not have to be an OpenClaw-operated tunnel. For public SaaS products
sending to a Gateway on a developer laptop, you need some reachable ingress such
as a reverse proxy, Cloudflare Tunnel, ngrok, Tailscale Funnel, or an enterprise
API gateway.

OpenClaw's Gateway WebSocket is the control plane used by the CLI and SDK for
operations such as dynamic subscription management and route tests. It is not a
replacement for provider webhook delivery. GitHub, Codebase, Meego, and similar
systems still deliver events by HTTP `POST` to the configured route; the
WebSocket path is how an operator tells the Gateway which routes to manage.

## What was verified

The enterprise webhook implementation was verified with three layers:

- Route behavior tests for 20 application patterns covering repository, issue
  tracking, incident, observability, billing, commerce, CRM, service desk,
  collaboration, document, database, form, CI/CD, deployment, and monitoring
  systems.
- Edge-case tests for authentication failure, event allowlists, duplicate
  deliveries, missing template fields, raw payload preservation, and
  route-specific authentication on shared paths.
- Array payload-path coverage for batched webhooks, where `events.0.type` and
  `events.0.id` resolve to event type and idempotency key.
- A live GitHub end-to-end run where a repository webhook delivered
  `pull_request` and `pull_request_review` events to a local Gateway through a
  public HTTPS tunnel, and OpenClaw scheduled matching `plugin:webhooks` agent
  turns.
- A live Codebase MR end-to-end run where a real merge request update delivered
  to the Webhooks plugin, scheduled an OpenClaw agent turn, and wrote the agent
  completion back as a Codebase MR review note.
- A live GitHub PR end-to-end run where a real pull request update delivered to
  the Webhooks plugin, scheduled an OpenClaw agent turn, and wrote the agent
  completion back as a GitHub PR comment.

The focused verification command was:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-misc.config.ts extensions/webhooks/src/config.test.ts extensions/webhooks/src/http.test.ts extensions/webhooks/index.test.ts
```

The targeted Webhooks plugin suite now covers auth, event allowlists,
idempotency, templating, agent dispatch, dynamic subscriptions, and completion
delivery.

A local HTTP smoke test also posted real HTTP requests to a running Node server
using the Webhooks plugin handler. The first batched event returned `ack` with
`eventType: "record.updated"` and `idempotencyKey: "evt-array-smoke-1"`;
replaying the same request returned `duplicate: true`.

## Source comparison

The comparison below is based on the local source trees for Hermes Agent,
OpenClaw, Claude Code, and Codex.

| System       | Webhook surface                                                                                                                                                                                                                                | Auth and filtering                                                                                                                                                                                                            | Dispatch model                                                                                                                                                                                       | Fit                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Hermes Agent | A generic `gateway/platforms/webhook.py` adapter exposes `/webhooks/{route_name}` with static and dynamic routes. Telegram and Feishu also have channel-specific webhook modes.                                                                | HMAC-style signature checks, GitLab token support, route event allowlists, route rate limits, body limits, and in-memory idempotency.                                                                                         | Converts a webhook into a messaging `MessageEvent`, starts an agent run, and stores delivery metadata so the final agent response can be logged, posted to GitHub, or delivered to another platform. | Strong for agent-as-chat-platform semantics and response delivery. Less typed, more route-specific behavior lives inside one adapter. |
| OpenClaw     | A bundled Webhooks plugin registers exact Gateway HTTP routes such as `/plugins/webhooks/github-pr-review`.                                                                                                                                    | Per-route bearer, header, or `hmac-sha256` auth; route-specific auth even on shared paths; event allowlists; body, rate, and in-flight guards; persistent idempotency when plugin state is available with in-memory fallback. | Dispatches to `ack`, managed TaskFlow, scheduled agent turn, or channel delivery. Prompt rendering supports body, headers, raw JSON, event type, idempotency key, and array payload paths.           | Strong for enterprise ingress because routes are typed plugin config and core remains plugin-agnostic.                                |
| Claude Code  | Feature-gated GitHub PR activity integration. Source references include `KAIROS_GITHUB_WEBHOOKS`, `SubscribePRTool`, `subscribe_pr_activity`, and `<github-webhook-activity>` message rendering.                                               | The checked local tree shows client/tool and rendering hooks, not a generic webhook receiver implementation in the CLI source.                                                                                                | GitHub PR events arrive as user messages in the Claude Code session. The coordinator prompt says mergeability still needs polling because GitHub does not webhook that state.                        | Narrow PR-subscription workflow, not general enterprise webhook ingress.                                                              |
| Codex        | The local app-server source exposes protocol operations such as `review/start` over the app-server transport. It also has authenticated WebSocket/app-server transport code, but no generic webhook receiver comparable to Hermes or OpenClaw. | App-server auth protects Codex protocol transport; it is not vendor webhook verification.                                                                                                                                     | Clients call Codex protocol methods such as review start, command exec, and thread operations.                                                                                                       | Strong protocol/server integration, but webhook ingestion belongs in an external bridge or host application.                          |

The main product difference is where the external event becomes agent input.
Hermes treats generic webhooks as a messaging platform. Claude Code treats PR
activity as a specialized subscribed message stream. Codex exposes review and
execution protocol methods that another service can call. OpenClaw makes webhook
ingress a Gateway plugin, so enterprise applications can connect without adding
vendor policy to core runtime code.

## Application connection matrix

Use one route per application or event family. Each route should have its own
secret, event allowlist, idempotency key, and prompt template. The examples below
are fully expanded in [Enterprise webhook integrations](/plugins/webhooks-enterprise-integrations).

| Application              | Typical events                             | Recommended auth                           | Idempotency key                                | Connection notes                                                               |
| ------------------------ | ------------------------------------------ | ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| GitHub                   | PR opened, synchronized, review submitted  | `hmac-sha256` with `x-hub-signature-256`   | `x-github-delivery`                            | Configure the repository webhook directly when the Gateway URL is reachable.   |
| GitLab                   | Merge request hook                         | Header token                               | `x-gitlab-event-uuid`                          | Use project webhooks and allow only merge request events.                      |
| Jira                     | Issue created, issue updated               | Bearer token or edge-added header          | `webhookEventId`                               | If Jira cannot add custom auth, put an API gateway in front.                   |
| PagerDuty                | Incident triggered, acknowledged, resolved | Bearer token or edge-added header          | `event.id`                                     | Announce high-priority incidents only when the target session should see them. |
| Sentry                   | Issue or error events                      | Header token                               | `id`                                           | Preserve `{__raw__}` so missing fields can still be debugged.                  |
| Datadog                  | Monitor and service check alerts           | Header token                               | `id`                                           | Keep noisy monitor recovery events out with `events`.                          |
| Stripe                   | Billing lifecycle events                   | Edge-verified signature plus forward token | `id`                                           | Verify `Stripe-Signature` before forwarding normalized JSON.                   |
| Shopify                  | Order create/update events                 | Edge-verified HMAC plus forward token      | `x-shopify-webhook-id`                         | Deduplicate retries; do not forward payment details unless required.           |
| HubSpot                  | Deal or contact property changes           | Bearer token                               | `eventId`                                      | App webhooks often benefit from a small verifier or normalizer.                |
| Salesforce               | Platform events or CDC                     | Bearer token                               | `ChangeEventHeader.commitNumber`               | Use an event relay, MuleSoft, or a private HTTP bridge.                        |
| ServiceNow               | Incident created/updated                   | Bearer token                               | `sys_id`                                       | Send only selected record fields from a flow action or outbound REST message.  |
| Zendesk                  | Ticket created/updated                     | Bearer token                               | `id`                                           | Attach the webhook to a trigger with a narrow condition.                       |
| Slack workflow           | Workflow step or form submitted            | Bearer token                               | `event_id`                                     | Good for human-initiated OpenClaw workflows.                                   |
| Teams and Power Automate | Approval or flagged message events         | Bearer token                               | `triggerId`                                    | Use an HTTP action to set the bearer token and JSON body.                      |
| Notion                   | Page created/updated                       | Bearer token                               | `id`                                           | Use automation or middleware that can call HTTP endpoints.                     |
| Airtable                 | Record created/updated                     | Bearer token                               | `webhook.id`                                   | Include base, table, record id, and changed fields.                            |
| Google Forms             | Form submitted                             | Bearer token                               | `responseId`                                   | Use Apps Script to post normalized JSON.                                       |
| Jenkins                  | Build completed/failed                     | Header token                               | `build.id`                                     | Send from a post-build action or HTTP Request step.                            |
| Argo CD                  | App synced/degraded                        | Bearer token                               | `app.metadata.uid` plus revision when possible | Keep deployment event prompts explicit about whether action is allowed.        |
| Prometheus Alertmanager  | Firing/resolved alert groups               | Bearer token                               | `groupKey` or alert fingerprint                | Route only actionable severities to agent dispatch.                            |

## How each application should connect

For a public SaaS application, configure its webhook endpoint as:

```text
https://<reachable-gateway-host>/plugins/webhooks/<route-id>
```

Then configure the matching route in OpenClaw:

```json5
{
  plugins: {
    entries: {
      webhooks: {
        enabled: true,
        config: {
          routes: {
            app_route: {
              path: "/plugins/webhooks/app-route",
              sessionKey: "agent:main:main",
              auth: {
                mode: "bearer",
                secret: {
                  source: "env",
                  provider: "default",
                  id: "APP_WEBHOOK_TOKEN",
                },
              },
              dispatch: {
                mode: "agent",
                agent: { deliveryMode: "none", delayMs: 1 },
              },
              event: { payloadPath: "type" },
              events: ["example.created", "example.updated"],
              idempotency: { payloadPath: "id", ttlHours: 24 },
              prompt: "Handle {type}: {__raw__}",
            },
          },
        },
      },
    },
  },
}
```

For an internal enterprise application, prefer a private route when possible:

- If the application and Gateway are in the same VPC or data center, expose only
  the webhook path through an internal load balancer or reverse proxy.
- If the application runs on the same machine, post to `http://127.0.0.1:<port>`
  and keep the route off the public network.
- If the application can only emit events to an enterprise message bus, deploy a
  small adapter that consumes the bus and posts normalized JSON to OpenClaw.
- If the application cannot send outbound webhooks, build a polling connector
  that calls the application API and then posts events to OpenClaw.

## Why Janus-style browser control does not need inbound access to Chrome

A Janus-style browser connector uses the opposite network direction from a
webhook. The browser is controlled by a Chrome extension running inside the
user's real Chrome profile. The extension uses Chrome extension APIs and
`chrome.debugger` to inspect and drive tabs, and it opens an outbound WebSocket
connection to a Janus server.

Once that outbound WebSocket exists, the server can send browser commands back
over the same connection. This is a reverse-connection pattern: the local
browser is not listening for inbound traffic from the internet. In local mode,
the extension can connect to a local agent on `127.0.0.1`. In hosted mode, it can
connect outward to a public Janus server. Either way, the user browser initiates
the connection, so NAT and firewalls usually allow it.

That model works for browser control because the controlled resource is the
Chrome extension itself, and the extension can maintain a long-lived outbound
session.

## Why webhooks are different

Webhook delivery starts at the source application. GitHub, Stripe, Jira, or an
internal service sends an HTTP `POST` to the URL you configured in that product.
If the OpenClaw Gateway is only listening on `localhost` on a laptop, a public
SaaS product cannot reach it.

That means a webhook route needs one of these deployment shapes:

- **Public HTTPS edge**: expose only `/plugins/webhooks/<route-id>` through an
  API gateway, reverse proxy, Cloudflare Tunnel, ngrok, Tailscale Funnel, or
  similar ingress service.
- **Cloud or server deployment**: run the Gateway on a host that the source
  system can reach directly.
- **Private enterprise ingress**: keep the route on a private load balancer,
  VPN, VPC peering link, or service mesh when both systems are inside the same
  enterprise network.
- **Source-side relay**: verify vendor signatures and normalize payloads in a
  small worker, then forward to OpenClaw with a simple bearer or header token.
- **Polling connector**: when the source cannot send webhooks, have OpenClaw or
  an adapter poll the source API and then dispatch equivalent events.
- **Future reverse connector**: a Janus-style event agent could keep an outbound
  session to OpenClaw and carry events back over that session, but that is a
  different connector pattern from the current Webhooks plugin.

So the current Webhooks plugin does not require one specific tunnel provider or
an OpenClaw-operated gateway. It does require reachability from the event source
to the route URL. Public SaaS to a local laptop normally requires a tunnel,
public reverse proxy, or relay. Internal app to internal Gateway does not.

## Recommended production pattern

For enterprise production, use an API gateway or reverse proxy in front of the
Gateway:

1. Expose only the exact webhook paths, not the full Gateway surface.
2. Terminate TLS at the edge.
3. Verify vendor-native signatures at the edge when OpenClaw does not implement
   that vendor's signing format directly.
4. Forward normalized JSON to OpenClaw with a route-specific bearer or header
   token.
5. Preserve the source delivery id in a header or payload path and configure
   OpenClaw idempotency.
6. Start each route in `ack` or `deliveryMode: "none"` while collecting payloads.
7. Switch to `agent`, `taskflow`, or `deliver` only after prompts and allowlists
   are stable.
8. Monitor `202`, `401`, skipped, duplicate, and downstream error responses.

This gives enterprise teams a simple integration surface without assuming every
application can safely call a local developer machine.

## See also

- [Webhooks plugin](/plugins/webhooks)
- [Enterprise webhook integrations](/plugins/webhooks-enterprise-integrations)
