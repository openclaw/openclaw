---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Vercel AI Gateway"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Vercel AI Gateway setup (auth + model selection)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use Vercel AI Gateway with OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need the API key env var or CLI auth choice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Vercel AI Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The [Vercel AI Gateway](https://vercel.com/ai-gateway) provides a unified API to access hundreds of models through a single endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `vercel-ai-gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `AI_GATEWAY_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- API: Anthropic Messages compatible（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Set the API key (recommended: store it for the Gateway):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice ai-gateway-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Set a default model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Non-interactive example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --auth-choice ai-gateway-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Environment note（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway runs as a daemon (launchd/systemd), make sure `AI_GATEWAY_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is available to that process (for example, in `~/.openclaw/.env` or via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`env.shellEnv`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
