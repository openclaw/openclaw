## Summary

When a user completes the Telegram channel setup without configuring an `allowFrom` list, the bot silently defaults to `dmPolicy: "pairing"`. This means **any Telegram user who discovers the bot can send pairing requests** — potentially gaining access to a bot that handles private data, files, or system commands.

Most users are not aware of this exposure. There is currently no warning in the setup flow to inform them.

## Problem

The `getCurrent` fallback in `setup-surface.ts` defaults to `pairing`:

```ts
getCurrent: (cfg) => cfg.channels?.telegram?.dmPolicy ?? 'pairing',
```

A user who completes the wizard without explicitly choosing a DM policy, or without adding `allowFrom` entries, ends up with an open bot and no indication of the risk.

## Solution

Added a `completionNote` to `telegramSetupWizard` that is conditionally shown after setup completes. It only triggers when:

1. `dmPolicy` is effectively `pairing` (default or explicitly set), **and**
2. `allowFrom` is empty or not configured

When shown, the note includes:

- A plain-language explanation of the exposure
- The exact CLI commands to switch to an allowlist
- A link to the pairing documentation

```
⚠️  Telegram DM access warning

Your bot is using the default DM policy (pairing).
Any Telegram user who discovers the bot can send pairing requests.
For private use, configure an allowlist with your Telegram user id:

  openclaw config set channels.telegram.dmPolicy "allowlist"
  openclaw config set channels.telegram.allowFrom "[YOUR_USER_ID]"

Docs: https://docs.openclaw.ai/channels/pairing
```

## Design decisions

- **No behavior change**: The default remains `pairing` to avoid breaking existing users. This is purely informational.
- **Minimal surface**: Only one file changed (`setup-surface.ts`). No schema changes, no new dependencies beyond existing `plugin-sdk/setup-tools` helpers.
- **Surgical condition**: Warning fires only on the exact unsafe combination (pairing + no allowFrom). Users who explicitly choose pairing are informed once; users who configure allowFrom correctly never see it.

## Testing

- All 977 existing Telegram tests pass
- TypeScript type-checks clean (`pnpm typecheck`)
- Formatting clean (`pnpm format:check`)

## Files changed

- `extensions/telegram/src/setup-surface.ts` — added `completionNote` with `shouldShow` guard
