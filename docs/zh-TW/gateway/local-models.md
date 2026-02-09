---
summary: "在本機 LLM（LM Studio、vLLM、LiteLLM、自訂 OpenAI 端點）上執行 OpenClaw"
read_when:
  - 您想從自己的 GPU 主機提供模型服務
  - 您正在串接 LM Studio 或 OpenAI 相容的代理
  - 您需要最安全的本機模型指引
title: "本機模型"
---

# 本機模型

Local is doable, but OpenClaw expects large context + strong defenses against prompt injection. Small cards truncate context and leak safety. Aim high: **≥2 maxed-out Mac Studios or equivalent GPU rig (~$30k+)**. A single **24 GB** GPU works only for lighter prompts with higher latency. Use the **largest / full-size model variant you can run**; aggressively quantized or “small” checkpoints raise prompt-injection risk (see [Security](/gateway/security)).

## 建議：LM Studio + MiniMax M2.1（Responses API，完整尺寸）

Best current local stack. 目前最佳的本機組合。在 LM Studio 中載入 MiniMax M2.1，啟用本機伺服器（預設 `http://127.0.0.1:1234`），並使用 Responses API 以將推理與最終文字分離。

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

### Hybrid config: hosted primary, local fallback

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

### Local-first with hosted safety net

對調主要與回退的順序；保留相同的 providers 區塊與 `models.mode: "merge"`，以便在本機主機停機時回退到 Sonnet 或 Opus。

### 區域託管／資料路由

- Hosted MiniMax/Kimi/GLM variants also exist on OpenRouter with region-pinned endpoints (e.g., US-hosted). Pick the regional variant there to keep traffic in your chosen jurisdiction while still using `models.mode: "merge"` for Anthropic/OpenAI fallbacks.
- 僅本機仍是最強的隱私路徑；當你需要提供者功能但又想控制資料流向時，託管的區域路由是折衷方案。

## 其他 OpenAI 相容的本機代理

vLLM, LiteLLM, OAI-proxy, or custom gateways work if they expose an OpenAI-style `/v1` endpoint. Replace the provider block above with your endpoint and model ID:

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

- Gateway can reach the proxy? Gateway 能連到代理嗎？`curl http://127.0.0.1:1234/v1/models`。
- LM Studio 模型被卸載？重新載入；冷啟動是常見的「卡住」原因。 Reload; cold start is a common “hanging” cause.
- 上下文錯誤？ 上下文錯誤？降低 `contextWindow` 或提高你的伺服器限制。
- 安全性：本機模型會略過提供者端的過濾；請保持代理程式範圍精簡並開啟壓縮，以限制提示注入的影響半徑。
