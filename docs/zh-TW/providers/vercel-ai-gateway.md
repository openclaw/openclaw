---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway 設定 (憑證 + 模型選擇)"
read_when:
  - 當你想在 OpenClaw 中使用 Vercel AI Gateway 時
  - 當你需要 API 金鑰環境變數或 CLI 憑證選擇時
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) 提供了一個統一的 API，可透過單一端點存取數百種模型。

- 供應商：`vercel-ai-gateway`
- 憑證：`AI_GATEWAY_API_KEY`
- API：相容於 Anthropic Messages

## 快速開始

1. 設定 API 金鑰 (建議：將其儲存在 Gateway)：

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

## 非互動式範例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## 環境說明

如果 Gateway 以背景服務 (daemon) 形式運行 (如 launchd/systemd)，請確保該程序可以存取 `AI_GATEWAY_API_KEY` (例如：在 `~/.openclaw/.env` 檔案中或透過 `env.shellEnv` 設定)。
