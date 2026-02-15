---
summary: "Together AI 設定 (驗證 + 模型選擇)"
read_when:
  - 您想在 OpenClaw 中使用 Together AI
  - 您需要 API 金鑰環境變數或 CLI 驗證選項
---

# Together AI

[Together AI](https://together.ai) 透過統一的 API 提供對領先的開源模型（包括 Llama、DeepSeek、Kimi 等）的存取。

- 提供者: `together`
- 驗證: `TOGETHER_API_KEY`
- API: 與 OpenAI 相容

## 快速入門

1. 設定 API 金鑰 (建議: 將其儲存在 Gateway):

```bash
openclaw onboard --auth-choice together-api-key
```

2. 設定預設模型:

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

這將把 `together/moonshotai/Kimi-K2.5` 設定為預設模型。

## 環境注意事項

如果 Gateway 作為守護行程 (launchd/systemd) 運行，請確保 `TOGETHER_API_KEY` 對該程序可用 (例如，在 `~/.clawdbot/.env` 或透過 `env.shellEnv`)。

## 可用模型

Together AI 提供對許多流行開源模型的存取:

- **GLM 4.7 Fp8** - 預設模型，具有 200K 上下文視窗
- **Llama 3.3 70B Instruct Turbo** - 快速、高效的指令遵循
- **Llama 4 Scout** - 具有圖像理解功能的視覺模型
- **Llama 4 Maverick** - 先進的視覺和推理
- **DeepSeek V3.1** - 強大的程式設計和推理模型
- **DeepSeek R1** - 高級推理模型
- **Kimi K2 Instruct** - 具有 262K 上下文視窗的高效能模型

所有模型都支援標準聊天完成，並與 OpenAI API 相容。
