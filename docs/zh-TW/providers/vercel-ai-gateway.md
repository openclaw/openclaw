---
title: Vercel AI Gateway
summary: Vercel AI Gateway setup (auth + model selection)
read_when:
  - You want to use Vercel AI Gateway with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) 提供一個統一的 API，透過單一端點即可存取數百個模型。

- 供應商：`vercel-ai-gateway`
- 認證：`AI_GATEWAY_API_KEY`
- API：相容 Anthropic Messages
- OpenClaw 可自動偵測 Gateway `/v1/models` 目錄，因此 `/models vercel-ai-gateway`
  包含目前的模型參考，例如 `vercel-ai-gateway/openai/gpt-5.4`。

## 快速開始

1. 設定 API 金鑰（建議：為 Gateway 儲存）：

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. 設定預設模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## 非互動範例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## 環境說明

如果 Gateway 以 daemon（launchd/systemd）方式執行，請確保 `AI_GATEWAY_API_KEY`
對該程序可用（例如放在 `~/.openclaw/.env` 或透過 `env.shellEnv`）。

## 模型 ID 簡寫

OpenClaw 支援 Vercel Claude 簡寫模型參考，並於執行時將其標準化：

- `vercel-ai-gateway/claude-opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4.6`
- `vercel-ai-gateway/opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4-6`
