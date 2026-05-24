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
  Use the nested SDK shape:

```json5
capabilities: {
  "google-chat": {
    delivery: { text: true, media: true, replyTo: true, thread: true },
    live: { draftPreview: false, previewFinalization: false, progressUpdates: false },
    receive: { webhook: true, ackAfterDurableSend: true },
    native: { appApi: true, workspaceHosted: true },
  },
}
```

`providers` is accepted as an alias for `accounts` when a broker service wants
that naming, but `accounts` is preferred because it matches the rest of
OpenClaw's multi-account channel tooling.

## Phase 3 platform matrix

Phase 3 broker providers should declare what each official/app channel can
actually do. A matrix row is evidence for routing and UI/status, not a promise
that OpenClaw ships a native migration for that platform in the same PR.

| Platform        | Canonical id      | Common aliases     | Expected broker shape                                                                                           |
| --------------- | ----------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Microsoft Teams | `microsoft-teams` | `msteams`, `teams` | Official app/API provider; workspace hosted; threads and replies when the provider supports the target surface. |
| Google Chat     | `google-chat`     | `googlechat`       | Official app/API provider; spaces and threads map to `conversation.id` plus `threadId`.                         |
| Matrix          | `matrix`          | -                  | Appservice or bridge provider; rooms map to channels; self-hosted deployments should mark that under `native`.  |
| LINE            | `line`            | -                  | Official bot provider; reply-token limits belong in provider metadata and receipt behavior.                     |
| Feishu          | `feishu`          | -                  | Official app provider; groups/chats route through provider-owned ids.                                           |
| QQ bot          | `qqbot`           | `qq`               | Regional bot provider; group and direct capability differences must be declared.                                |
| Zalo            | `zalo`            | -                  | Regional bot/provider API; personal-account parity is not implied.                                              |
| Mattermost      | `mattermost`      | -                  | App/API provider; self-hosted constraints should be visible as native metadata.                                 |
| Nextcloud Talk  | `nextcloud-talk`  | -                  | App/API provider; self-hosted constraints should be visible as native metadata.                                 |
| Twitch          | `twitch`          | -                  | Channel-chat provider; usually channel-only and threadless.                                                     |
| IRC             | `irc`             | -                  | Bridge/provider mode; media, replies, and threads are usually unsupported.                                      |
| Nostr           | `nostr`           | -                  | Relay-based provider; expose relay and direct-message constraints through `native`.                             |
| Tlon            | `tlon`            | -                  | App/API or bridge provider; self-hosted or private-network facts stay in `native`.                              |
| Synology Chat   | `synology-chat`   | -                  | App/API provider; self-hosted constraints should be visible as native metadata.                                 |

Canonical ids stay open-ended. Providers can still declare additional platform
ids, but these aliases give OpenClaw one stable migration vocabulary for the
maintained channel set.

## Phase 4 constrained providers

Device-bound and account-constrained platforms must declare their limits instead
of looking like hosted bot APIs. Use `constraints` for machine-readable facts
and `badges` for short UI/status labels:

```json5
capabilities: {
  whatsapp: {
    delivery: { text: true, media: true, replyTo: true },
    constraints: { businessApi: true, cloudApi: true, providerHosted: true },
    badges: ["business-api", "provider-hosted"],
    native: { cloudApi: true },
  },
  signal: {
    delivery: { text: true },
    constraints: {
      selfHosted: true,
      deviceBound: true,
      phoneNumberRequired: true,
      signalCli: true,
    },
    badges: ["self-hosted", "device-bound"],
    native: { signalCli: true },
  },
  imessage: {
    delivery: { text: true, media: true, replyTo: true },
    constraints: {
      deviceBound: true,
      macHostRequired: true,
      messagesSignedIn: true,
      privateApiOptional: true,
    },
    badges: ["mac-host", "device-bound"],
    native: { imsg: true },
  },
}
```

Recommended constrained-provider interpretation:

| Platform    | Broker posture                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp    | Prefer Business/Cloud-style provider integrations for hosted broker providers. QR/linked-device providers must declare `deviceBound`, `qrPairing`, `linkedDevice`, and `sessionFragile` rather than claiming Business API parity. |
| Signal      | Treat as self-hosted/device-bound. Providers should declare `selfHosted`, `deviceBound`, `phoneNumberRequired`, and `signalCli` when backed by `signal-cli`.                                                                      |
| iMessage    | Treat as Mac-hosted/device-bound. Providers should declare `macHostRequired`, `messagesSignedIn`, and private API requirements.                                                                                                   |
| BlueBubbles | Do not revive a native OpenClaw BlueBubbles channel. A broker provider may expose an iMessage bridge it owns and badge it with `externalBridge`.                                                                                  |

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
