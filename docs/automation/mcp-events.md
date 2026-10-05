---
doc-schema-version: 1
summary: "Subscribe to MCP events and run existing Automations from signed webhooks"
read_when:
  - Connecting an MCP event source to an automation
  - Configuring or troubleshooting signed MCP Events callbacks
  - Testing subscription renewal, duplicate delivery, or restart recovery
title: "MCP Events"
---

MCP Events connects a remote MCP server to [Automations](/automation/cron-jobs).
The MCP server filters changes and sends signed webhooks. OpenClaw durably accepts
them and runs the automation's existing instructions, tool policy, delivery, and
history. Events do not introduce another scheduler or require an MCP App view to
remain open.

## Supported profile

The bundled, opt-in `mcp-events` plugin implements the
[OpenAI webhook profile](https://developers.openai.com/plugins/build/mcp-events):
MCP protocol `2026-07-28`, `server/discover`, `events/list`,
`events/subscribe`, and `events/unsubscribe` over Streamable HTTP.
It uses OpenClaw's existing configured MCP connections and authentication.
Legacy MCP tool connections keep their existing handshake.

This is a versioned integration with an experimental specification, not a claim
of support for every draft Events feature. Polling, push streams, and the draft's
`gap` and `terminated` webhook notifications are not part of this profile.

## Configure the callback

Connect the server through the existing [MCP settings](/tools/mcp), then enable
the plugin with a public HTTPS callback origin:

```json5
{
  mcp: {
    servers: {
      reviews: {
        transport: "streamable-http",
        url: "https://mcp.example.com/mcp",
      },
    },
  },
  plugins: {
    entries: {
      "mcp-events": {
        enabled: true,
        config: {
          callbackOrigin: "https://events.example.com",
        },
      },
    },
  },
}
```

The origin must have no credentials, path, query, or fragment. Route only
`/plugins/mcp-events/callback/` to the Gateway through your HTTPS reverse proxy.
Do not expose the Control UI, Gateway WebSocket, or other administrative paths.
OpenClaw does not open a tunnel or change your network configuration.

The remote server must be able to reach this origin and verify its TLS
certificate. Public DNS validation is a prerequisite, not proof of reachability;
subscription callback verification supplies that proof. Infrastructure that
requires an additional interactive sign-in or bearer header cannot accept these
callbacks without a separately configured route: MCP Events supplies its own
per-subscription HMAC authentication.

Use the existing MCP credential configuration or sign-in flow. Do not place MCP
bearer tokens or webhook signing secrets in the automation's instructions.

## Create an event automation

The plugin exposes the `mcp_events` discovery tool, which lists one page of
webhook events and their argument schemas for a configured `serverName`. It does
not create a separate subscription or scheduling system. The same catalog is
available in the Automation editor.

Create an automation with an event source, an agent-turn payload, and explicit
output delivery. The source references the configured MCP server; it does not
contain a second connection URL or credential store.

The automation job shape is:

```json
{
  "name": "Review new document comments",
  "agentId": "main",
  "enabled": true,
  "schedule": {
    "kind": "event",
    "source": "mcp-events",
    "options": {
      "server": "reviews",
      "name": "comment.created",
      "arguments": { "document_id": "doc_example" }
    }
  },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize the new review comment. Do not modify the document."
  },
  "delivery": { "mode": "none" }
}
```

This example retains results in automation run history without sending a chat
announcement. Configure the usual [delivery destination](/automation/cron-jobs/delivery)
when results should be sent to a channel or conversation. Prefer isolated runs
for external comments and documents. The event is untrusted data, separate from
the instructions the user authorized; signatures do not make payload text trusted
instructions or grant additional tools.

Event arguments must satisfy the server's `inputSchema`. Delivered data must
satisfy its `payloadSchema`. The server applies subscription filters before
sending events. Event names, descriptions, and schemas come from that server and
are not trusted authorization facts.

## Subscription lifecycle

OpenClaw prepares a callback binding and signing secret before subscribing. The
server can therefore send its signed verification challenge before returning the
subscription ID. Verification confirms the callback; it never starts an agent.

Subscriptions have finite leases. OpenClaw refreshes them before the server's
`refreshBefore` deadline, using the existing Gateway scheduler and the last
persisted cursor. Protocol maintenance does not invoke a model. Setting `cron.triggers.enabled` to
`false` pauses event-run admission as well as the existing trigger surfaces,
without discarding already accepted events. Subscription
state survives Gateway restarts; the originating chat turn or app view does not
own its lifetime. An unavailable source keeps retrying with backoff capped at
five minutes while its automation remains enabled; pausing or removing the
automation cancels that recovery work.

Pausing, removing, or replacing a source prevents new event runs from the retired
source generation. Late requests cannot reactivate it. Remote unsubscribe uses
the original event name, arguments, and callback URL. If cleanup cannot establish
current credential authority, it fails closed; the finite remote lease bounds
orphan lifetime. Re-enabling an automation does not revive callbacks from its
previous generation.

Requester-scoped connections retain their authenticated owner. An unavailable or
revoked requester connection does not fall back to shared operator credentials.
Intake and queued dispatch revalidate through the credential owner. Successful
token refresh preserves the binding; disconnect/reconnect creates a different
authorization lifetime and does not revive old callbacks. Temporary credential
store failures return retryable responses and retain queued work. Custom
requester connection resolvers must supply a live authorization observation, not
only a URL and headers. Remote-only revocation is detectable only when the
provider reports it or an authenticated request observes rejection. Durable
auth-profile sources use their actual shared or agent credential owner; personal
model-account IDs, external-only credentials, and bounded or environment-only
auth scopes are not promoted to ambient shared authority.

## Receipt, execution, and recovery

A successful webhook response acknowledges durable receipt, not model completion
or output delivery. OpenClaw verifies the signature over the exact request body,
checks the signing timestamp and source binding, and stores the event before
returning `2xx`. One request contains one event, no larger than 256 KiB.

The existing ingress queue retains pending events while an automation is busy.
Duplicate event IDs are scoped to their source binding; they do not suppress
unrelated events from another server or subscription. The handoff to a run
transfers the ingress claim and records the automation receipt together. Before
that transfer, restart recovery can retry admission. After it, the run receipt
owns completion or interruption; OpenClaw does not automatically repeat a
possibly side-effecting run to hide an uncertain outcome.

The plugin's `maxPendingEvents` setting bounds pending intake (default 10,000).
Full intake refuses new events rather than evicting already accepted work. Pending
and claimed events are never retention-evicted. Completed and failed ingress
records use the shared 30-day / 20,000-record-per-account retention bounds;
deduplication is bounded by that retained history. Retired subscription secrets
are removed after remote cleanup or the bounded lease cleanup window.
Execution errors, intentional pauses, invalidated sources, and successful
receipt are different outcomes; inspect automation history and plugin health
rather than treating a webhook `2xx` as task success.

### Limits of replay

MCP Events does not guarantee end-to-end exactly-once effects or that every
upstream event arrives. Servers can exhaust their retry budget. Event delivery
can be out of order. A `null` cursor means the source offers no replay, and
`truncated: true` means requested history is no longer available.

Cursors are opaque watermarks, not values to sort or compare numerically. The
draft permits a watermark to pass events abandoned by the server. For critical
workflows, reconcile against authoritative source state and make write actions
idempotent. A durable local queue protects accepted events; it cannot recover
changes the source never delivered and no longer retains.

## Disable or downgrade

Pause or remove event automations before disabling the plugin. To downgrade to an
OpenClaw version that predates event schedules, first remove those jobs using the
current version, or restore a compatible pre-feature backup. Older versions do
not understand the persisted `event` schedule kind; disabling the plugin alone
does not convert it to a timed schedule.

## Developer proof server

The repository includes `scripts/mcp-events-test-server.mjs` and
`test/fixtures/mcp-events/README.md`. This is a real authenticated HTTP MCP
server with signed callbacks, JSON and request-scoped SSE responses, durable
fixture subscriptions, and controls for duplicates, invalid signatures, bursts,
expiry, rotation, revocation, restart, and replay.

Use only synthetic records and fixture-only credentials. Run the Gateway with
isolated state and a dedicated profile. A fixture's delivery response alone is
not end-to-end proof: verify the actual automation run, persisted outcome, and
intended effect. Never disable TLS verification or weaken production callback
validation to make a test pass.

## Related

- [Automations](/automation/cron-jobs)
- [Inbound webhooks](/automation/cron-jobs/webhooks) — separate bearer-authenticated hooks
- [MCP connections](/tools/mcp)
- [Plugin service runtime](/plugins/sdk-runtime/gateway-and-nodes)
