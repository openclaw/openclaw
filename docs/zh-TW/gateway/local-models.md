---
summary: "Run OpenClaw on local LLMs (LM Studio, vLLM, LiteLLM, custom OpenAI endpoints)"
read_when:
  - You want to serve models from your own GPU box
  - You are wiring LM Studio or an OpenAI-compatible proxy
  - You need the safest local model guidance
title: Local Models
---

# Local models

本地環境是可行的，但 OpenClaw 期望有大型上下文 + 強大的防禦措施來抵禦提示注入。小型卡片會截斷上下文並洩漏安全性。目標要高：**≥2 台滿配的 Mac Studio 或同等 GPU 設備（約 $30,000 以上）**。單一 **24 GB** 的 GPU 僅適用於較輕的提示，且延遲較高。使用 **你能執行的最大 / 全尺寸模型變體**；過度量化或「小型」檢查點會提高提示注入的風險（請參見 [Security](/gateway/security)）。

如果你想要最低摩擦的本地設置，請從 [Ollama](/providers/ollama) 開始，並參考 `openclaw onboard`。這個頁面是針對高端本地堆疊和自訂的 OpenAI 相容本地伺服器的意見指南。

## 推薦：LM Studio + MiniMax M2.5（回應 API，全尺寸）

最佳當前本地堆疊。將 MiniMax M2.5 載入 LM Studio，啟用本地伺服器（預設 `http://127.0.0.1:1234`），並使用 Responses API 來保持推理與最終文本的分離。

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.5-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.5-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**設置檢查清單**

- 安裝 LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- 在 LM Studio 中，下載 **可用的最大 MiniMax M2.5 版本**（避免使用「小型」或高度量化的變體），啟動伺服器，確認 `http://127.0.0.1:1234/v1/models` 列出它。
- 保持模型加載；冷啟動會增加啟動延遲。
- 如果你的 LM Studio 版本不同，請調整 `contextWindow`/`maxTokens`。
- 對於 WhatsApp，請使用 Responses API，這樣只會發送最終文本。

保持已設定的託管模型，即使在本地執行時也要使用 `models.mode: "merge"`，以便回退選項仍然可用。

### 混合設定：託管主伺服器，當地備援

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.5-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.5-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### 本地優先與託管安全網

交換主要和備用的順序；保持相同的提供者區塊和 `models.mode: "merge"`，以便在本地盒子故障時可以回退到 Sonnet 或 Opus。

### 區域性託管 / 數據路由

- 在 OpenRouter 上也存在托管的 MiniMax/Kimi/GLM 變體，並且有區域固定的端點（例如，美國托管）。在那裡選擇區域變體，以便在選擇的法域內保持流量，同時仍然使用 `models.mode: "merge"` 進行 Anthropic/OpenAI 的後備。
- 僅限本地仍然是最強的隱私路徑；托管的區域路由則是在需要提供者功能但希望控制數據流時的中間選擇。

## 其他與 OpenAI 相容的本地代理

vLLM、LiteLLM、OAI-proxy 或自訂閘道如果暴露 OpenAI 風格的 `/v1` 端點則可以正常運作。請將上面的提供者區塊替換為您的端點和模型 ID：

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

保持 `models.mode: "merge"` 以便託管模型作為備援可用。

## 故障排除

- Gateway 可以連接到代理嗎？`curl http://127.0.0.1:1234/v1/models`。
- LM Studio 模型已卸載？重新加載；冷啟動是常見的“掛起”原因。
- 上下文錯誤？降低 `contextWindow` 或提高您的伺服器限制。
- 安全性：本地模型跳過提供者端的過濾器；保持代理狹窄並啟用壓縮以限制提示注入的影響範圍。
