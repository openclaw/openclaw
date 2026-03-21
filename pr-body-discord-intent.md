## Summary

When a Discord bot account is added to OpenClaw without enabling the "Message Content Intent" in the Discord Developer Portal, the `monitorDiscordProvider` call throws an unhandled error that crashes the **entire Gateway** — taking down all channels (Telegram, WhatsApp, other Discord bots, etc.).

## Details

Wrapped `monitorDiscordProvider` in a try/catch in `channel.ts`. When the call fails:

- A warning is logged identifying the account ID and error reason
- The account status is set to `running: false` with `lastError`
- The error is NOT rethrown — preventing crash propagation

Only the misconfigured account is disabled. All other channels continue running normally.

## Related Issues

Fixes #27002

## How to Validate

1. Add a Discord bot token for an account WITHOUT "Message Content Intent" enabled
2. Start the gateway
3. Confirm only that Discord account fails — Telegram and other channels stay online
4. Check `openclaw status` — shows the failed account with `lastError`

Run unit tests: `pnpm test -- --testPathPattern=discord/src/channel`

## Pre-Merge Checklist

- [x] Updated relevant documentation and README (if needed)
- [x] Added/updated tests (if needed)
- [ ] Noted breaking changes (if any)
- [x] Validated on required platforms/methods:
  - [x] Windows
    - [x] npm run
