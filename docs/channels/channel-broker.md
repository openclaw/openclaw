---
summary: "Provider-owned broker channel for consolidating Slack, Discord, Telegram, WhatsApp, Signal, iMessage, Matrix, and long-tail messaging providers"
title: "Channel Broker"
read_when:
  - You want one provider-owned channel surface instead of platform-specific OpenClaw channel plugins
  - You are building a broker provider for Slack, Discord, Telegram, WhatsApp, Signal, iMessage, or Matrix
  - You are migrating channel behavior onto the broker protocol
---

`channel-broker` is the consolidation channel for provider-owned messaging
integrations. OpenClaw keeps the common message lifecycle, session routing,
allowlists, `/verbose` and streaming policy, durable final sends, receipts,
retries, and audit fields. Broker providers own platform mechanics such as bot
APIs, bridge daemons, device-bound connectors, native ids, and per-platform
quirks.

The V1 transport is outbound HTTP from OpenClaw to the provider plus signed
inbound HTTP webhooks from the provider to OpenClaw. WebSocket and provider
polling transports are reserved for later protocol versions.

## Target syntax

Use the broker-owned prefix when native channel plugins are still installed:

```text
broker:telegram:chat%20123?threadId=topic%2F77
channel-broker:discord:123456789012345678
broker:slack:C12345678?threadId=1700000000.000100
channel-broker:matrix:!roomid:example.org
```

The broker also declares platform prefixes for migration environments, but
native channel plugins keep ownership of their own prefixes while they are
registered. For example, `telegram:...` still routes to the native Telegram
plugin when both Telegram and the broker are installed; if Telegram is not
registered, a configured broker can own `telegram:...`.

## Config

```json5
{
  channels: {
    "channel-broker": {
      defaultProviderId: "acme",
      accounts: {
        acme: {
          enabled: true,
          baseUrl: "https://broker.example.com",
          outboundToken: { source: "env", provider: "default", id: "BROKER_TOKEN" },
          signingSecret: { source: "env", provider: "default", id: "BROKER_SIGNING_SECRET" },
          platforms: ["slack", "discord", "telegram"],
          defaultConversationType: "channel",
          allowFrom: ["*"],
        },
      },
    },
  },
}
```

Provider keys:

- `baseUrl` - provider HTTP endpoint. OpenClaw posts outbound requests to
  `/v1/outbound`.
- `outboundToken` - optional bearer token for outbound provider calls. Plaintext
  strings and SecretRef objects are supported.
- `signingSecret` - provider webhook signature secret for inbound events.
  Plaintext strings and SecretRef objects are supported.
- `platforms` - normalized platform ids the provider can handle.
- `platformAliases` - optional alias map for provider-local platform names.
- `defaultConversationType` - fallback conversation type when a target does not
  encode one; defaults to `channel`.
- `allowFrom` - sender allowlist used by broker inbound events.
- `capabilities` - optional per-platform capability metadata for UI/status.

`providers` is accepted as an alias for `accounts` when a broker service wants
that naming, but `accounts` is preferred because it matches the rest of
OpenClaw's multi-account channel tooling.

## Provider contract

Providers import the broker protocol types from
`openclaw/plugin-sdk/channel-broker`:

- `BrokerInboundEventV1`
- `BrokerOutboundRequestV1`
- `BrokerReceiptV1`
- `BrokerProviderCapabilities`
- `BrokerProviderHealth`

Outbound requests include platform id, provider id, provider account id,
conversation id/type/thread id, payloads, reply/silent relation fields,
delivery requirements, and opaque native metadata. Receipts must return stable
message ids and can include edit/delete tokens plus opaque native metadata.

## Migration notes

Broker-compatible platforms:

- Slack, Discord, Telegram, Microsoft Teams, Google Chat, and Matrix fit the
  broker model through official bot/app APIs or mature bridge APIs.
- WhatsApp fits through Business/Cloud-style providers or QR-device providers
  with capability badges.
- Signal and iMessage require self-hosted or device-bound providers; expose
  those limits through provider capabilities instead of pretending they match
  hosted bot APIs.

Keep legacy channel plugins available for security and compatibility while new
channel behavior moves through broker conformance tests.

## Related

- [Channel message API](/plugins/sdk-channel-message)
- [Channel broker SDK](/plugins/sdk-channel-broker)
- [Streaming](/concepts/streaming)
- [Thinking and verbose directives](/tools/thinking)
