---
summary: "Split inbound mention handling into plugin-owned evidence gathering and shared policy evaluation"
read_when:
  - Your channel decides when a group message should wake the agent
  - You need reply-to-bot or quoted-bot implicit mention handling
title: "Channel mention policy"
sidebarTitle: "Mention policy"
---

Decide when an inbound message counts as a mention, without reimplementing
the shared policy. Part of the [Building channel
plugins](/plugins/sdk-channel-plugins) guide.

## Inbound mention policy

Keep inbound mention handling split in two layers:

- plugin-owned evidence gathering
- shared policy evaluation

Use `openclaw/plugin-sdk/channel-mention-gating` for mention-policy decisions.
Use `openclaw/plugin-sdk/channel-inbound` only when you need the broader
inbound helper barrel.

Good fit for plugin-local logic:

- reply-to-bot detection
- quoted-bot detection
- thread-participation checks
- service/system-message exclusions
- platform-native caches needed to prove bot participation

Good fit for the shared helper:

- `requireMention`
- explicit mention result
- implicit mention allowlist
- command bypass
- final skip decision

For a qualified group-thread entry, compute explicit participant mention facts
once with `resolveGroupThreadMentionFacts({ cfg, channel, peerId, text, sessionKey, acpBinding })`
from `openclaw/plugin-sdk/channel-inbound`, including direct conversations. Pass
the resolved session key and whether a configured ACP binding owns the route.
It returns `undefined` for an exclusive ACP route or when no qualified entry
applies, otherwise the resolved group and `mentionedAgentIds`. If routing changes
after preparation, use `isGroupThreadRouteExclusive({ sessionKey, acpBinding })`
to discard participant facts for an ACP-owned destination and reevaluate admission
using only the final route’s ordinary mention and command facts.
Merge a non-empty participant match with the routed agent’s local mention facts before
the ordinary gate, and carry the same selection facts into dispatch. A mention
of a non-routed participant must not be dropped by a single-agent gate.
Participant selection requires an `@`-style match; a bare name or emoji does not
select an agent. Keep sender authorization and command policy unchanged.

Set the optional `replyOptions.groupThreadReplyFormatter(text, participant)` to
apply the adapter’s participant label to source-conversation message-tool replies.
The participant contains `agentId` and `name`; reuse the same transport formatter
used for ordinary replies with participant delivery metadata.

For plugin-owned sends, read `getGroupThreadDeliverySession()` from the same SDK
at delivery entry. When present, use its `agentId` and `sessionKey` for media
roots, internal hooks, and transcript mirrors, including unlabeled single-agent
groups. Keep transport account ownership unchanged. Shared durable delivery
selects the active participant context and run identity in core.

Preferred flow:

1. Compute local mention facts.
2. Pass those facts into `resolveInboundMentionDecision({ facts, policy })`.
3. Use `decision.effectiveWasMentioned`, `decision.shouldBypassMention`, and
   `decision.shouldSkip` in your inbound gate.

```typescript
import {
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelImplicitMentions } from "openclaw/plugin-sdk/channel-ingress-runtime";

const wasMentioned = matchesMentionWithExplicit({
  text,
  mentionRegexes,
  explicit: {
    hasAnyMention,
    isExplicitlyMentioned,
    canResolveExplicit,
  },
});

const facts = {
  canDetectMention: true,
  wasMentioned,
  hasAnyMention,
  implicitMentionKinds: [
    ...implicitMentionKindWhen("reply_to_bot", isReplyToBot),
    ...implicitMentionKindWhen("quoted_bot", isQuoteOfBot),
  ],
};

const implicitMentions = resolveChannelImplicitMentions({
  cfg,
  channel: channelId,
  accountId,
});

const decision = resolveInboundMentionDecision({
  facts,
  policy: {
    isGroup,
    requireMention,
    implicitMentions,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  },
});

if (decision.shouldSkip) return;
```

`matchesMentionWithExplicit(...)` returns a boolean. `hasAnyMention`,
`isExplicitlyMentioned`, and `canResolveExplicit` come from the channel's own
native mention metadata (message entities, reply-to-bot flags, and similar);
supply `false`/`undefined` values when your platform cannot detect them.

`api.runtime.channel.mentions` exposes the same shared mention helpers for
bundled channel plugins that already depend on runtime injection:
`buildMentionRegexes`, `matchesMentionPatterns`, `matchesMentionWithExplicit`,
`implicitMentionKindWhen`, `resolveInboundMentionDecision`.

If you only need `implicitMentionKindWhen` and `resolveInboundMentionDecision`,
import from `openclaw/plugin-sdk/channel-mention-gating` to avoid loading
unrelated inbound runtime helpers.
