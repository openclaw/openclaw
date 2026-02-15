---
summary: "在 local LLM（LM Studio、vLLM、LiteLLM、自訂 OpenAI 端點）上執行 OpenClaw"
read_when:
  - 您想從自己的 GPU 機器提供模型服務
  - 您正在連接 LM Studio 或 OpenAI 相容的代理
  - 您需要最安全的本機模型指南
title: "本機模型"
---

# 本機模型

本機執行是可行的，但 OpenClaw 需要大型上下文 + 強大的提示注入防禦。小記憶體會截斷上下文並洩漏安全性。目標要高：**≥2 台頂規 Mac Studios 或同等 GPU 設備（約 $30k+）**。單張 **24 GB** GPU 僅適用於較輕的提示，且延遲較高。請使用**您可以執行的最大/完整尺寸模型變體**；積極量化或「小型」檢查點會增加提示注入風險（請參閱[安全性](/gateway/security)）。

## 推薦：LM Studio + MiniMax M2.1 (Responses API, 完整尺寸)

目前最佳的本機堆疊。在 LM Studio 中載入 MiniMax M2.1，啟用本機伺服器（預設 `http://127.0.0.1:1234`），並使用 Responses API 將推論與最終文字分開。

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
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

**設定清單**

- 安裝 LM Studio：[https://lmstudio.ai](https://lmstudio.ai)
- 在 LM Studio 中，下載**可用的最大 MiniMax M2.1 版本**（避免「小型」/重度量化變體），啟動伺服器，確認 `http://127.0.0.1:1234/v1/models` 中列出了它。
- 保持模型載入；冷載入會增加啟動延遲。
- 如果您的 LM Studio 版本不同，請調整 `contextWindow`/`maxTokens`。
- 對於 WhatsApp，請堅持使用 Responses API，這樣只會傳送最終文字。

即使執行本機模型，也要保持託管模型的設定；使用 `models.mode: "merge"` 以便備用方案保持可用。

### 混合設定：託管為主，本機備用

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
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

### 本機優先，託管作為安全網

交換主要和備用的順序；保持相同的 providers 區塊和 `models.mode: "merge"`，這樣當本機機器關閉時可以回退到 Sonnet 或 Opus。

### 區域託管 / 資料路由

- 託管的 MiniMax/Kimi/GLM 變體也存在於 OpenRouter 上，帶有區域固定的端點（例如，美國託管）。選擇那裡的區域變體，以將流量保持在您選擇的管轄區內，同時仍使用 `models.mode: "merge"` 作為 Anthropic/OpenAI 備用。
- 純本機仍然是最強的隱私路徑；當您需要供應商功能但又想控制資料流時，託管區域路由是折衷方案。

## 其他 OpenAI 相容的本機代理

vLLM、LiteLLM、OAI-proxy 或自訂 Gateway都可以運作，只要它們公開 OpenAI 風格的 `/v1` 端點。用您的端點和模型 ID 替換上面的 provider 區塊：

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

保持 `models.mode: "merge"` 以便託管模型作為備用保持可用。

## 疑難排解

- Gateway能連線到代理嗎？`curl http://127.0.0.1:1234/v1/models`。
- LM Studio 模型已卸載？重新載入；冷啟動是常見的「卡住」原因。
- 上下文錯誤？降低 `contextWindow` 或提高您的伺服器限制。
- 安全性：本機模型會跳過供應商端的篩選器；保持智慧代理範圍狹窄並開啟壓縮以限制提示注入的影響範圍。
