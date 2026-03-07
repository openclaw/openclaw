# Feishu Group Mention Arbitration

## Problem

In Feishu group collaboration, multiple bot accounts can receive the same inbound event.
That creates duplicate replies in two common cases:

1. User mentions only a specialist bot, but `main` still receives the message because `main.requireMention=false`.
2. User mentions both `main` and a specialist bot, so both accounts may reply.

Prompt-only mitigation is insufficient because Feishu mention placeholders are stripped from the inbound body before the agent sees the message content.

## Change

The Feishu channel now performs mention arbitration at inbound dispatch time.

Rules:

1. If a group message mentions only a specialist bot, `main` skips dispatch.
2. If a group message mentions both `main` and the currently addressed specialist bot, the specialist bot skips dispatch.
3. If a group message mentions multiple specialist bots without `main`, `main` keeps dispatch and all mentioned specialist bots skip direct dispatch.
4. Plain `@main` or normal group messages continue to route to `main`.

## Implementation

Files:
- `extensions/feishu/src/bot.ts`
- `extensions/feishu/src/monitor.ts`
- `extensions/feishu/src/bot.checkBotMentioned.test.ts`
- `extensions/feishu/src/monitor.main-sibling-mention.test.ts`

Key points:
- Added `extractMentionedOpenIds(event)` so both text and post messages share one mention extraction path.
- Added mention arbitration in `im.message.receive_v1` before `handleFeishuMessage()` dispatch.
- Added tests for:
  - specialist-only mention
  - `main + specialist`
  - post message mention handling

## Scope

This change only controls duplicate inbound dispatch.
It does not change downstream orchestration, internal `sessions_send`, or any environment-specific prompt policy.
