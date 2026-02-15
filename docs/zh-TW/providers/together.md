---
summary: "Together AI 設定 (驗證 + 模型選擇)"
read_when:
  - 您想在 OpenClaw 中使用 Together AI
  - 您需要 API 金鑰環境變數或 CLI 驗證選項
---

# Together AI

[Together AI](https://together.ai) 透過統一的 API 提供存取多種領先的開源模型，包括 Llama、DeepSeek、Kimi 等。

- 供應商：`together`
- 驗證：`TOGETHER_API_KEY`
- API：相容 OpenAI

## 快速開始

1. 設定 API 金鑰（建議：儲存至 Gateway）：

```bash
openclaw onboard --auth-choice together-api-key
```

2. 設定預設模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "together/moonshotai/Kimi-K2.5" },
    },
  },
}
```

## 非互動式範例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

這會將 `together/moonshotai/Kimi-K2.5` 設為預設模型。

## 環境說明

如果 Gateway 以守護行程 (daemon, 如 launchd/systemd) 執行，請確保該程序可以存取 `TOGETHER_API_KEY`（例如，存放在 `~/.clawdbot/.env` 檔案中或透過 `env.shellEnv` 設定）。

## 可用模型

Together AI 提供許多熱門開源模型的存取權：

- **GLM 4.7 Fp8** - 具備 200K 上下文視窗的預設模型
- **Llama 3.3 70B Instruct Turbo** - 快速且高效的指令遵循模型
- **Llama 4 Scout** - 具備圖像理解能力的視覺模型
- **Llama 4 Maverick** - 先進的視覺與推理模型
- **DeepSeek V3.1** - 強大的程式碼編寫與推理模型
- **DeepSeek R1** - 先進的推理模型
- **Kimi K2 Instruct** - 高效能模型，具備 262K 上下文視窗

所有模型皆支援標準對話補全 (chat completions)，且與 OpenAI API 相容。
