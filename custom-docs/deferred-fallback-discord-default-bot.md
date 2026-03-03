---
summary: Deferred rollout plan to split Discord default fallback onto a dedicated bot
read_when:
  - Preparing to separate fallback/default Discord identity from agent-bound identities
title: Deferred: Dedicated Discord Fallback Bot
---

# Deferred: Dedicated Discord Fallback Bot

Status: deferred (not applied yet)

## Background

Current runtime fallback uses channels.discord.accounts.default and it is intentionally aligned with ruda for stability. This avoids Discord bot token missing for account default errors when account resolution falls back to default.

## Why split later

- Reduce identity coupling between fallback/system traffic and the ruda agent identity.
- Improve audit clarity for operational messages vs agent-authored messages.
- Make future token rotation safer and less disruptive.

## Target state

- Keep existing per-agent bindings (agentId -> accountId) unchanged.
- Create a dedicated Discord bot identity for accounts.default.
- Move fallback/system/human-initiated unbound flows to that dedicated default account.

## Rollout (future)

1. Provision a dedicated Discord bot and token.
2. Set channels.discord.accounts.default to the dedicated token/config.
3. Keep channels.discord.accounts.ruda unchanged.
4. Restart ai.openclaw.gateway.
5. Verify no fallback token errors and confirm expected bot identities in outbound messages.

## Rollback

- Restore channels.discord.accounts.default to previous known-good value (currently aligned with ruda).
- Restart gateway and re-check logs.

## Validation checklist

- No new Discord bot token missing for account default log entries.
- Per-agent mapped messages still use each agent bound bot identity.
- Fallback/unbound flows resolve through the dedicated default identity.
