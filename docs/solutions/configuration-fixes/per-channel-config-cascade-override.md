---
title: "Adding a per-channel config cascade override (maxConcurrentPerConversation)"
category: configuration-fixes
tags: [config, cascade, channels, discord, telegram, slack, concurrency, lanes, zod, typescript]
module: Config / Agent Runner / Command Queue
symptom: "Global concurrency limit applies uniformly; no way to tune per-channel or per-guild"
root_cause: "Resolver only read agents.defaults.maxConcurrentPerConversation, ignoring channel config hierarchy"
date_solved: 2026-02-22
commits: ["ebc36d7f0", "8d75fb025"]
files_changed:
  - src/config/agent-limits.ts
  - src/config/types.discord.ts
  - src/config/types.telegram.ts
  - src/config/types.slack.ts
  - src/config/zod-schema.providers-core.ts
  - src/agents/pi-embedded-runner/run.ts
  - src/agents/pi-embedded-runner/compact.ts
  - src/process/command-queue.ts
---

# Adding a Per-Channel Config Cascade Override

## Problem

The conversation lane feature (`6556ccedf`) added `maxConcurrentPerConversation` as a global default in `agents.defaults`. Users with mixed deployments (busy Discord servers vs quiet Telegram DMs, production vs dev accounts) could not tune concurrency per-context.

## Investigation: Which Pattern to Follow

The codebase has **two** config override patterns. Choosing the wrong one was the initial mistake during planning.

### The anomaly: `historyLimit`

`historyLimit` exists only at the account/provider level. It does **not** cascade through guilds, groups, or channels. The brainstorm initially referenced this as the pattern to follow. Three review agents agreed — all wrong.

### The established pattern: `requireMention`, `tools`, `skills`, `systemPrompt`, `enabled`, `allowFrom`

Every other per-channel setting follows deep cascades with `??` chains at point-of-use:

```
Discord:  channel → guild → provider → global
Telegram: group → provider → global
Slack:    channel → provider → global
```

Real examples in the codebase:

- `src/discord/monitor/allow-list.ts:435` — `channelConfig?.requireMention ?? guildInfo?.requireMention ?? true`
- `src/telegram/bot-message-context.ts:243` — `firstDefined(topicConfig?.requireMention, groupConfig?.requireMention, baseRequireMention)`

**Lesson: When reviewers recommend against matching established patterns, verify which pattern they're comparing against. `historyLimit` is the exception, not the rule.**

## Solution

### 1. Add field to TypeScript types (3 files, 7 locations)

Add `maxConcurrentPerConversation?: number` to existing channel config types, placed next to `requireMention` (not `historyLimit`) to signal it follows the cascade pattern:

- **Discord:** `DiscordGuildChannelConfig`, `DiscordGuildEntry`, `DiscordAccountConfig`
- **Telegram:** `TelegramGroupConfig`, `TelegramAccountConfig` — NOT `TelegramTopicConfig` (see gotcha below)
- **Slack:** `SlackChannelConfig`, `SlackAccountConfig`

### 2. Add to Zod schemas (1 file, 7 schemas)

Same `z.number().int().min(1).max(10).optional()` added to each corresponding schema in `zod-schema.providers-core.ts`. Cap at 10 prevents misconfiguration that defeats rate-limit protection.

### 3. Standalone resolver in `agent-limits.ts`

Created `resolveMaxConcurrentPerConversation()` with typed provider config access. Uses `cfg.channels?.discord` (typed as `DiscordConfig`) instead of `Record<string, unknown>` casts. Only the flat-provider fallback needs a narrow cast.

### 4. Wire into `run.ts` and `compact.ts`

Replace `resolveAgentMaxConcurrentPerConversation(params.config)` with:

```typescript
resolveMaxConcurrentPerConversation({
  cfg: params.config,
  channel: params.messageChannel,
  groupSpace: params.groupSpace,
  peerId: params.messageTo,
});
```

Both files already had `messageChannel`, `groupSpace`, and `messageTo` available. No new params needed.

### 5. Lane system improvements in `command-queue.ts`

Two improvements identified during implementation:

**Idempotency guard:** `setCommandLaneConcurrency` called on every message, but only needs to `drainLane` when the value actually changes.

**Idle lane eviction:** Conversation lanes (`conv:*`) accumulate in the `Map` over the lifetime of the process. Evict them when empty (queue=0, active=0) to bound memory to peak-concurrent rather than lifetime-unique conversations.

## Gotchas and Bugs Found

### 1. `peerId` prefix stripping (caught during planning)

`messageTo` uses delivery-target format: `channel:123456789`, `group:-100123`, `user:999`. Config keys are bare IDs: `123456789`. Must strip the prefix before config lookup.

Helper: `stripPeerPrefix(peerId)` extracts everything after the first `:`.

### 2. `indexOf` vs `lastIndexOf` (caught in review)

Initial implementation used `lastIndexOf(":")` which would incorrectly split `thread:channel:123` into just `123` instead of `channel:123`. Changed to `indexOf(":")` to strip only the first prefix segment. While multi-colon peerIds don't exist today, `indexOf` better communicates intent and is future-proof.

### 3. Telegram `groupSpace` is not populated (caught during planning)

Unlike Discord (where `groupSpace` = guild ID), Telegram does not populate `groupSpace` at the runner level. The group ID must be extracted from `peerId` instead. The resolver handles this with: `stripPeerPrefix(params.groupSpace ?? params.peerId)`.

### 4. Telegram topic-level override is not useful (design decision)

Conversation lanes key on `peerId` (chat ID), not topic ID. A topic-level `maxConcurrentPerConversation` override could never select a different lane from its parent group. Intentionally skipped `TelegramTopicConfig`.

### 5. `compact.ts` lacks full routing context (accepted limitation)

Standalone compaction may not have `groupSpace` for Discord. Falls back to provider-level override rather than guild-level. This matches the existing behavior where compaction has less routing context than the main run path.

### 6. Cross-agent awareness breaks at concurrency > 1 (documented limitation)

Multiple agents sharing a conversation lane miss each other's replies in the shared JSONL session. Session file writes are NOT independently serialized. This is a pre-existing design constraint, not introduced by this feature — but configuring `maxConcurrentPerConversation > 1` makes it actionable.

## Prevention Strategies

### When adding a new per-channel config field

1. **Identify the correct cascade pattern** — Check `requireMention`, `tools`, `skills` (deep cascade), NOT `historyLimit` (flat). Read the actual code in `allow-list.ts`, `bot-message-context.ts`, `policy.ts`.
2. **Add to TypeScript types AND Zod schemas** — 7 locations each: Discord (3), Telegram (2), Slack (2).
3. **Strip `peerId` prefix** — Always use `indexOf(":")` not `lastIndexOf(":")`.
4. **Handle Telegram's missing `groupSpace`** — Fall back to extracting from `peerId`.
5. **Skip Telegram topics** if the setting keys on `peerId` rather than topic ID.
6. **Add idempotency guards** when the resolver is called on every message (hot path).
7. **Write cascade tests for each provider** — Discord 4-level, Telegram 3-level, Slack 3-level, flat 2-level.

### Test patterns for cascade resolution

- Test each cascade level wins when set (channel > guild > provider > global)
- Test fallback when intermediate levels are missing
- Test with both prefixed (`channel:123`) and bare (`123`) peerIds
- Test Zod rejects out-of-range values (< 1, > max)
- Test Zod accepts the field as optional

## References

- Brainstorm: `docs/brainstorms/2026-02-21-per-channel-concurrency-override-brainstorm.md`
- Plan: `docs/plans/2026-02-22-feat-per-channel-conversation-concurrency-override-plan.md`
- Discord cascade example: `src/discord/monitor/allow-list.ts:435`
- Telegram cascade example: `src/telegram/bot-message-context.ts:243`
- MS Teams cascade example: `extensions/msteams/src/policy.ts:227`
