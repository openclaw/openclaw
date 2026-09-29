# OpenClaw Kimi Coding Provider

Official OpenClaw provider plugin for Kimi Coding.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/kimi-provider
openclaw gateway restart
```

See <https://docs.openclaw.ai/providers/moonshot> for setup and configuration.

## Quota errors

Kimi can return HTTP 403 when a weekly usage limit is exhausted. OpenClaw treats
explicit weekly, seven-day, or quota-reset errors as rate limits. Wait for the
provider's quota window to reset or use another configured provider; replacing a
valid API key does not restore quota. Invalid keys and access restrictions keep
their authentication error handling.

## Catalog notes

Model rows live in `openclaw.plugin.json` under `modelCatalog.providers.kimi`.

- `k3` serves up to 1M context, tier-gated server-side; `k3-256k` is the cheaper
  256K variant of the same weights. Both point at `moonshot/kimi-k3` through
  `upstreamModel`, which keeps their `compat` capability tiers aligned with the
  `moonshot` catalog for the same model.
- Legacy `k3[1m]` was retired upstream and normalizes to `k3` for shipped
  configurations.
- `KIMI_K3_MODEL_IDS` in `provider-policy-api.ts` must cover exactly the catalog
  rows that carry a K3 `thinkingLevelMap`; `provider-catalog.test.ts` asserts it.
