---
title: "Tencent Cloud (TokenHub + Token Plan)"
summary: "Tencent Cloud TokenHub and Token Plan setup (separate keys)"
read_when:
  - You want to use Tencent Hy models with OpenClaw
  - You need the TokenHub API key or Token Plan (LKEAP) setup
---

# Tencent Cloud (TokenHub + Token Plan)

The Tencent Cloud provider gives access to Tencent Hy models via two endpoints
with separate API keys:

- **TokenHub** (`tencent-tokenhub`) — call Hy via Tencent TokenHub Gateway
- **Token Plan** (`tencent-token-plan`) — call Hy via the LKEAP
  Token Plan endpoint

Both providers use OpenAI-compatible APIs.

## Quick start

TokenHub:

```bash
openclaw onboard --auth-choice tokenhub-api-key
```

Token Plan:

```bash
openclaw onboard --auth-choice tencent-token-plan-api-key
```

## Non-interactive example

```bash
# TokenHub
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice tokenhub-api-key \
  --tokenhub-api-key "$TOKENHUB_API_KEY" \
  --skip-health \
  --accept-risk

# Token Plan
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice tencent-token-plan-api-key \
  --tencent-token-plan-api-key "$LKEAP_API_KEY" \
  --skip-health \
  --accept-risk
```

## Providers and endpoints

| Provider             | Endpoint                              | Use case                |
| -------------------- | ------------------------------------- | ----------------------- |
| `tencent-tokenhub`   | `tokenhub.tencentmaas.com/v1`         | Hy via Tencent TokenHub |
| `tencent-token-plan` | `api.lkeap.cloud.tencent.com/plan/v3` | Hy via LKEAP Token Plan |

Each provider uses its own API key. Setup registers only the selected provider.

## Available models

### tencent-tokenhub

- **hy3-preview** — Hy3 preview (256K context, reasoning, default)

### tencent-token-plan

- **hy3-preview** — Hy3 preview (256K context, reasoning, default)

## Notes

- TokenHub model refs use `tencent-tokenhub/<modelId>`. Token Plan model refs
  use `tencent-token-plan/<modelId>`.
- Override pricing and context metadata in `models.providers` if needed.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `TOKENHUB_API_KEY`
or `LKEAP_API_KEY` is available to that process (for example, in
`~/.openclaw/.env` or via `env.shellEnv`).

## Related documentation

- [OpenClaw Configuration](/configuration)
- [Model Providers](/concepts/model-providers)
- [Tencent TokenHub](https://cloud.tencent.com/document/product/1823/130050)
- [Tencent Token Plan API](https://cloud.tencent.com/document/product/1823/130060)
