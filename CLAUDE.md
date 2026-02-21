# OpenClaw (Fork)

Personal fork of OpenClaw -- multi-channel AI assistant gateway. This is the upstream source for local development and contributions.

## Commands

```bash
pnpm install
pnpm build        # Full build (tsdown + plugin SDK + canvas + hooks)
pnpm dev          # Run gateway in dev mode
pnpm test         # Parallel unit tests
pnpm test:fast    # Unit tests only (vitest)
pnpm test:e2e     # End-to-end tests
pnpm check        # Format check + tsgo + lint
pnpm lint         # oxlint --type-aware
pnpm format       # oxfmt --write
```

## Stack

TypeScript (ESM), pnpm, tsdown, Vitest, oxlint/oxfmt, Node >= 22

## Code Style

- TypeScript strict, ESM (`"type": "module"`)
- Format with oxfmt, lint with oxlint (type-aware)
- Max 500 LOC per file (`pnpm check:loc`)
- camelCase for variables/functions

## Notes

- This is a fork -- keep in sync with upstream `openclaw/openclaw`
- Gateway runs as launchd/systemd daemon
- Channels: iMessage, WhatsApp, Telegram, Slack, Discord, Signal, Teams, etc.
