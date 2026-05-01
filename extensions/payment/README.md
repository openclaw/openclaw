# Payment plugin

OpenClaw plugin for agent-driven purchases via virtual card (Stripe Link) and machine payment (MPP/HTTP 402), with approval gating and sentinel-based card fill.

**User docs:** `docs/plugins/payment.md`

**Developer notes:** `DEV_NOTES.md`

## Build / test

```bash
# From the worktree root:
pnpm test extensions/payment

# From this directory:
pnpm plugin:check
```

## License

MIT
