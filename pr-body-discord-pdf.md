## Summary

When a Discord Nitro user uploads a large file (e.g., a ~32MB PDF), OpenClaw's message listener crashes and stops receiving inbound messages in that channel. The root cause is an unhandled fetch failure when the Discord CDN returns HTTP 404 for Nitro-sized attachments.

## Details

Wrapped `resolveMediaList()` and `resolveForwardedMediaList()` calls in `message-handler.process.ts` with individual try/catch blocks. On failure:

- A warning is logged with the message ID and error reason
- Processing continues with whatever media was already resolved
- The message listener does NOT crash — the channel keeps receiving messages

## Related Issues

Fixes #47649

## How to Validate

1. Upload a large file (>8MB) via Discord Nitro to a channel monitored by OpenClaw
2. Confirm the bot continues responding to subsequent messages in the same channel
3. Check logs — warning shows the failed attachment, processing continues

Run unit tests: `pnpm test -- --testPathPattern=message-handler.process`

## Pre-Merge Checklist

- [x] Updated relevant documentation and README (if needed)
- [x] Added/updated tests (if needed)
- [ ] Noted breaking changes (if any)
- [x] Validated on required platforms/methods:
  - [x] Windows
    - [x] npm run
