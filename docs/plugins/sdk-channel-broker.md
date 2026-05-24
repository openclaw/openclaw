---
summary: "Channel broker SDK protocol for provider-owned messaging integrations"
title: "Channel broker SDK"
read_when:
  - You are implementing a channel broker provider
  - You need the broker protocol types for inbound events, outbound requests, receipts, capabilities, or health
  - You are migrating platform channel behavior behind the broker contract
---

The channel broker SDK lives at `openclaw/plugin-sdk/channel-broker`. It is a
small, versioned protocol surface for providers that want OpenClaw to own common
message semantics while the provider owns platform mechanics.

## V1 types

```typescript
import type {
  BrokerInboundEventV1,
  BrokerOutboundRequestV1,
  BrokerReceiptV1,
  BrokerProviderCapabilities,
  BrokerProviderHealth,
} from "openclaw/plugin-sdk/channel-broker";
```

V1 uses signed inbound HTTP webhooks and outbound HTTP calls. WebSocket and
provider polling transports are intentionally deferred so providers can first
prove the stable message lifecycle contract.

## Outbound request

`BrokerOutboundRequestV1` includes:

- `requestId`, `providerId`, `platform`, and optional provider `accountId`.
- `conversation` with id, type, parent id, thread id, and title.
- `mode`, including final sends, preview updates, preview finalization, typing,
  and reactions.
- `payloads` with text, attachments, and provider-owned `channelData`.
- `relation` for reply, silent, and native quote references.
- `requirements` describing durable delivery features OpenClaw expects.

Providers should return `BrokerReceiptV1` with stable message ids, status,
optional edit/delete tokens, timestamps, and native metadata.

## Target helpers

Use these helpers to normalize provider target ids:

```typescript
import {
  BROKER_KNOWN_PLATFORM_IDS,
  BROKER_PLATFORM_ALIASES,
  buildBrokerConversationTarget,
  createBrokerOutboundRequest,
  createBrokerReceipt,
  normalizeBrokerKnownPlatformId,
  normalizeBrokerPlatformId,
  parseBrokerConversationTarget,
} from "openclaw/plugin-sdk/channel-broker";
```

`buildBrokerConversationTarget({ platform: "Telegram", conversationId:
"chat 123", threadId: "topic/7" })` produces a stable target like
`telegram:chat%20123?threadId=topic%2F7`.

`normalizeBrokerPlatformId(...)` validates and lowercases provider platform
ids. `normalizeBrokerKnownPlatformId(...)` additionally applies OpenClaw's
logical aliases for maintained channels, such as `teams` and `msteams` to
`microsoft-teams`, `googlechat` to `google-chat`, and `qq` to `qqbot`.
`BROKER_KNOWN_PLATFORM_IDS` is a catalog, not a closed enum; broker providers
can still introduce additional platform ids.

## Capabilities

Declare platform capabilities with the same nested shape used by
`BrokerPlatformCapabilities`:

```typescript
const googleChatCapabilities = {
  platform: "google-chat",
  delivery: { text: true, media: true, replyTo: true, thread: true },
  live: { draftPreview: false, previewFinalization: false, progressUpdates: false },
  receive: { webhook: true, ackAfterDurableSend: true },
  native: { appApi: true, workspaceHosted: true },
};
```

Provider-wide `delivery`, `live`, and `receive` defaults merge with
platform-specific entries when OpenClaw evaluates support. Put platform facts
that do not affect the generic broker lifecycle in `native`, for example
`appApi`, `bridgeApi`, `regionalApi`, `workspaceHosted`, `selfHostedOptional`,
`channelOnly`, or `relayBased`.

## Responsibilities

OpenClaw owns sessions, allowlists, routing, model-run lifecycle, `/verbose`,
streaming policy, durable final sends, receipt commits, retries, and audit
fields. Broker providers own platform APIs, delivery fanout, bridge/device
state, native ids, attachment hosting, and platform-specific metadata.

## Related

- [Channel Broker](/channels/channel-broker)
- [Channel message API](/plugins/sdk-channel-message)
