---
summary: "在本機 LLM（LM Studio、vLLM、LiteLLM、自訂 OpenAI 端點）上執行 OpenClaw"
read_when:
  - 您想從自己的 GPU 主機提供模型服務
  - 您正在串接 LM Studio 或 OpenAI 相容的代理
  - 您需要最安全的本機模型指引
title: "本機模型"
x-i18n:
  source_path: gateway/local-models.md
  source_hash: 82164e8c4f0c7479
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:05Z
---

# 本機模型

本機可行，但 OpenClaw 預期需要**大型上下文**與**強力的提示注入防護**。小顯卡會截斷上下文並外洩安全性。目標應拉高：**≥2 台滿配 Mac Studio 或等級相當的 GPU 機架（約 ~$30k+）**。單張 **24 GB** GPU 只適用於較輕量的提示，且延遲較高。請使用**你能執行的最大／完整尺寸模型變體**；過度量化或「小型」檢查點會提高提示注入風險（見 [Security](/gateway/security)）。

## 建議：LM Studio + MiniMax M2.1（Responses API，完整尺寸）

目前最佳的本機組合。在 LM Studio 中載入 MiniMax M2.1，啟用本機伺服器（預設 `http://127.0.0.1:1234`），並使用 Responses API 以將推理與最終文字分離。

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

**設定檢查清單**

- 安裝 LM Studio：<https://lmstudio.ai>
- 在 LM Studio 中下載**可取得的最大 MiniMax M2.1 版本**（避免「small」／高度量化變體），啟動伺服器，並確認 `http://127.0.0.1:1234/v1/models` 有列出該模型。
- 保持模型常駐載入；冷啟動會增加啟動延遲。
- 若你的 LM Studio 版本不同，請調整 `contextWindow`/`maxTokens`。
- WhatsApp 請使用 Responses API，確保只送出最終文字。

即使執行本機模型，也請保留託管模型設定；使用 `models.mode: "merge"` 以確保仍可回退。

### 混合設定：託管為主，本機回退

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

### 本機優先，託管安全網

對調主要與回退的順序；保留相同的 providers 區塊與 `models.mode: "merge"`，以便在本機主機停機時回退到 Sonnet 或 Opus。

### 區域託管／資料路由

- OpenRouter 也提供託管的 MiniMax／Kimi／GLM 變體，並有區域固定的端點（例如 US-hosted）。在該處選擇區域變體，以在你選定的司法轄區內保留流量，同時仍可使用 `models.mode: "merge"` 作為 Anthropic／OpenAI 的回退。
- 僅本機仍是最強的隱私路徑；當你需要提供者功能但又想控制資料流向時，託管的區域路由是折衷方案。

## 其他 OpenAI 相容的本機代理

vLLM、LiteLLM、OAI-proxy 或自訂閘道器可行，只要它們暴露 OpenAI 風格的 `/v1` 端點。將上方的 provider 區塊替換為你的端點與模型 ID：

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

請保留 `models.mode: "merge"`，讓託管模型能作為回退。

## 疑難排解

- Gateway 能連到代理嗎？`curl http://127.0.0.1:1234/v1/models`。
- LM Studio 模型被卸載？重新載入；冷啟動是常見的「卡住」原因。
- 上下文錯誤？降低 `contextWindow` 或提高你的伺服器限制。
- 安全性：本機模型會略過提供者端的過濾；請保持代理程式範圍精簡並開啟壓縮，以限制提示注入的影響半徑。
