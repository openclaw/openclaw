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
  buildBrokerConversationTarget,
  createBrokerOutboundRequest,
  createBrokerReceipt,
  normalizeBrokerPlatformId,
  parseBrokerConversationTarget,
} from "openclaw/plugin-sdk/channel-broker";
```

`buildBrokerConversationTarget({ platform: "Telegram", conversationId:
"chat 123", threadId: "topic/7" })` produces a stable target like
`telegram:chat%20123?threadId=topic%2F7`.

## Responsibilities

OpenClaw owns sessions, allowlists, routing, model-run lifecycle, `/verbose`,
streaming policy, durable final sends, receipt commits, retries, and audit
fields. Broker providers own platform APIs, delivery fanout, bridge/device
state, native ids, attachment hosting, and platform-specific metadata.

## Related

- [Channel Broker](/channels/channel-broker)
- [Channel message API](/plugins/sdk-channel-message)
