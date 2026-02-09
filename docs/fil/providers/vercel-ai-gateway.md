---
title: "Vercel AI Gateway"
summary: "Setup ng Vercel AI Gateway (auth + pagpili ng model)"
read_when:
  - Gusto mong gamitin ang Vercel AI Gateway kasama ang OpenClaw
  - Kailangan mo ang API key env var o ang pagpipilian sa auth ng CLI
---

# Vercel AI Gateway

Ang [Vercel AI Gateway](https://vercel.com/ai-gateway) ay nagbibigay ng iisang API para ma-access ang daan-daang model sa pamamagitan ng isang endpoint.

- Provider: `vercel-ai-gateway`
- Auth: `AI_GATEWAY_API_KEY`
- API: compatible sa Anthropic Messages

## Mabilis na pagsisimula

1. Itakda ang API key (inirerekomenda: i-store ito para sa Gateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Magtakda ng default na model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Halimbawa na non-interactive

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Tala sa environment

Kung tumatakbo ang Gateway bilang daemon (launchd/systemd), tiyaking `AI_GATEWAY_API_KEY`
ay available sa prosesong iyon (halimbawa, sa `~/.openclaw/.env` o sa pamamagitan ng
`env.shellEnv`).
