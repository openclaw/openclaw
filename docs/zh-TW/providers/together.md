---
summary: Together AI setup (auth + model selection)
read_when:
  - You want to use Together AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Together AI

[Together AI](https://together.ai) 提供透過統一 API 存取領先的開源模型，包括 Llama、DeepSeek、Kimi 等。

- 服務提供者：`together`
- 認證方式：`TOGETHER_API_KEY`
- API：相容 OpenAI

## 快速開始

1. 設定 API 金鑰（建議：存放於 Gateway）：

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

## 非互動範例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

這將設定 `together/moonshotai/Kimi-K2.5` 為預設模型。

## 環境說明

如果 Gateway 以 daemon（launchd/systemd）方式執行，請確保 `TOGETHER_API_KEY` 對該程序可用（例如放在 `~/.openclaw/.env` 或透過 `env.shellEnv`）。

## 可用模型

Together AI 提供存取多款熱門開源模型：

- **GLM 4.7 Fp8** - 預設模型，具備 20 萬上下文視窗
- **Llama 3.3 70B Instruct Turbo** - 快速且高效的指令追蹤模型
- **Llama 4 Scout** - 具備影像理解能力的視覺模型
- **Llama 4 Maverick** - 進階視覺與推理模型
- **DeepSeek V3.1** - 強大的程式碼與推理模型
- **DeepSeek R1** - 進階推理模型
- **Kimi K2 Instruct** - 高效能模型，具備 26.2 萬上下文視窗

所有模型皆支援標準聊天補全，並相容於 OpenAI API。
