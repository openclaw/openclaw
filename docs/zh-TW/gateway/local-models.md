---
summary: "在本地 LLM（LM Studio、vLLM、LiteLLM、自定義 OpenAI 端點）上執行 OpenClaw"
read_when:
  - 您想從自己的 GPU 設備提供模型服務
  - 您正在連接 LM Studio 或相容於 OpenAI 的代理伺服器
  - 您需要最安全的本地模型指南
title: "本地模型"
---

# 本地模型

本地執行是可行的，但 OpenClaw 需要較大的上下文長度（context length）以及針對提示詞注入（prompt injection）的強大防禦能力。小型顯示卡會截斷上下文並導致安全性漏洞。建議配置：**2 台以上頂規 Mac Studio 或同等效能的 GPU 設備（約 3 萬美元以上）**。單張 **24 GB** GPU 僅適用於較簡單的提示詞，且延遲較高。請使用**您能執行的最大 / 完整版模型變體**；過度量化或「小型」的模型權重會增加提示詞注入風險（請參閱 [Security](/gateway/security)）。

## 推薦：LM Studio + MiniMax M2.1 (Responses API, 完整版)

目前最佳的本地技術棧。在 LM Studio 中載入 MiniMax M2.1，啟用本地伺服器（預設為 `http://127.0.0.1:1234`），並使用 Responses API 將推理性內容與最終文字分開。

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
- 在 LM Studio 中，下載**可用的最大 MiniMax M2.1 版本**（避免使用「小型」或高度量化的變體），啟動伺服器，並確認 `http://127.0.0.1:1234/v1/models` 中有列出該模型。
- 保持模型載入狀態；冷啟動會增加延遲。
- 如果您的 LM Studio 版本不同，請調整 `contextWindow`/`maxTokens`。
- 對於 WhatsApp，請堅持使用 Responses API，以確保僅傳送最終文字。

即使在本地執行，也請保留託管模型的設定；使用 `models.mode: "merge"` 以確保備援（fallback）模型可用。

### 混合設定：託管主模型，本地備援

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

### 本地優先，託管模型作為安全網

調換主模型與備援模型的順序；保留相同的 providers 區塊與 `models.mode: "merge"`，以便在本地設備離線時可以備援回 Sonnet 或 Opus。

### 區域託管 / 數據路由

- OpenRouter 上也提供託管的 MiniMax/Kimi/GLM 變體，並具有固定區域的端點（例如美國託管）。在那裡選擇區域變體，可以將流量保持在您選擇的管轄區內，同時仍可使用 `models.mode: "merge"` 進行 Anthropic/OpenAI 的備援。
- 「僅限本地」仍然是最強的隱私保護路徑；當您需要供應商功能但想控制數據流向時，託管的區域路由是折衷方案。

## 其他相容於 OpenAI 的本地代理伺服器

如果 vLLM、LiteLLM、OAI-proxy 或自定義 Gateway 提供 OpenAI 風格的 `/v1` 端點，則可以使用它們。請將上方的 provider 區塊替換為您的端點和模型 ID：

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

保持 `models.mode: "merge"`，使託管模型可作為備援使用。

## 疑難排解

- Gateway 是否可以連接到代理伺服器？`curl http://127.0.0.1:1234/v1/models`。
- LM Studio 模型是否已卸載？請重新載入；冷啟動是常見的「卡住」原因。
- 上下文錯誤？降低 `contextWindow` 或調高您的伺服器限制。
- 安全性：本地模型會跳過供應商端的過濾器；請保持智慧代理的功能專一並開啟壓縮（compaction），以限制提示詞注入的影響範圍。
