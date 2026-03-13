---
summary: Use OpenAI via API keys or Codex subscription in OpenClaw
read_when:
  - You want to use OpenAI models in OpenClaw
  - You want Codex subscription auth instead of API keys
title: OpenAI
---

# OpenAI

OpenAI 提供 GPT 模型的開發者 API。Codex 支援 **ChatGPT 登入** 以訂閱方式存取，或 **API 金鑰** 登入以用量計費方式存取。Codex 雲端服務需要 ChatGPT 登入。OpenAI 明確支援在外部工具/工作流程（如 OpenClaw）中使用訂閱 OAuth。

## 選項 A：OpenAI API 金鑰（OpenAI 平台）

**適合對象：** 直接 API 存取及用量計費。  
請從 OpenAI 控制台取得您的 API 金鑰。

### CLI 設定

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 設定片段

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

OpenAI 目前的 API 模型文件列出 `gpt-5.4` 和 `gpt-5.4-pro` 用於直接 OpenAI API 使用。OpenClaw 會將兩者都轉發至 `openai/*` Responses 路徑。OpenClaw 有意隱藏過時的 `openai/gpt-5.3-codex-spark` 欄位，因為直接呼叫 OpenAI API 時會被拒絕。

OpenClaw **不會**在直接 OpenAI API 路徑上暴露 `openai/gpt-5.3-codex-spark`。`pi-ai` 仍內建該模型的欄位，但目前 OpenAI API 的實際請求會拒絕它。Spark 在 OpenClaw 中被視為僅限 Codex。

## 選項 B：OpenAI Code (Codex) 訂閱

**適合對象：** 使用 ChatGPT/Codex 訂閱存取，而非 API 金鑰。  
Codex 雲端服務需要 ChatGPT 登入，Codex CLI 則支援 ChatGPT 或 API 金鑰登入。

### CLI 設定（Codex OAuth）

bash

# 在精靈中執行 Codex OAuth

openclaw onboard --auth-choice openai-codex

# 或直接執行 OAuth

openclaw models auth login --provider openai-codex

### 設定片段（Codex 訂閱）

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

OpenAI 目前的 Codex 文件將 `gpt-5.4` 列為現行的 Codex 模型。OpenClaw 將其對應到 `openai-codex/gpt-5.4`，用於 ChatGPT/Codex OAuth 認證。

如果您的 Codex 帳號有權限使用 Codex Spark，OpenClaw 也支援：

- `openai-codex/gpt-5.3-codex-spark`

OpenClaw 將 Codex Spark 視為僅限 Codex，不會直接提供 `openai/gpt-5.3-codex-spark` API 金鑰路徑。

OpenClaw 也會保留 `openai-codex/gpt-5.3-codex-spark`，當 `pi-ai` 偵測到時。請將其視為依權限而定且實驗性功能：Codex Spark 與 GPT-5.4 `/fast` 是分開的，且可用性取決於登入的 Codex / ChatGPT 帳號。

### 傳輸預設

OpenClaw 使用 `pi-ai` 進行模型串流。對於 `openai/*` 和 `openai-codex/*`，預設傳輸方式為 `"auto"`（優先 WebSocket，失敗後降級為 SSE）。

您可以設定 `agents.defaults.models.<provider/model>.params.transport`：

- `"sse"`：強制使用 SSE
- `"websocket"`：強制使用 WebSocket
- `"auto"`：先嘗試 WebSocket，失敗後降級為 SSE

對於 `openai/*`（Responses API），當使用 WebSocket 傳輸時，OpenClaw 預設也會啟用 WebSocket 預熱 (`openaiWsWarmup: true`)。

相關 OpenAI 文件：

- [使用 WebSocket 的即時 API](https://platform.openai.com/docs/guides/realtime-websocket)
- [串流 API 回應（SSE）](https://platform.openai.com/docs/guides/streaming-responses)

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.4" },
      models: {
        "openai-codex/gpt-5.4": {
          params: {
            transport: "auto",
          },
        },
      },
    },
  },
}
```

### OpenAI WebSocket 預熱

OpenAI 文件中描述預熱為可選功能。OpenClaw 預設啟用 `openai/*`，以降低使用 WebSocket 傳輸時的首次回應延遲。

### 停用預熱

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: false,
          },
        },
      },
    },
  },
}
```

### 明確啟用預熱

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: true,
          },
        },
      },
    },
  },
}
```

### OpenAI 優先處理

OpenAI 的 API 透過 `service_tier=priority` 提供優先處理功能。在 OpenClaw 中，設定 `agents.defaults.models["openai/<model>"].params.serviceTier`，可在直接 `openai/*` 回應請求時傳遞該欄位。

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            serviceTier: "priority",
          },
        },
      },
    },
  },
}
```

支援的值有 `auto`、`default`、`flex` 及 `priority`。

### OpenAI 快速模式

OpenClaw 提供一個共用的快速模式切換，適用於 `openai/*` 和 `openai-codex/*` 會話：

- 聊天/UI：`/fast status|on|off`
- 設定：`agents.defaults.models["<provider>/<model>"].params.fastMode`

啟用快速模式時，OpenClaw 會套用低延遲的 OpenAI 設定：

- 當 payload 尚未指定推理時，使用 `reasoning.effort = "low"`
- 當 payload 尚未指定詳盡度時，使用 `text.verbosity = "low"`
- 對直接 `openai/*` 回應呼叫，使用 `service_tier = "priority"` 至 `api.openai.com`

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
        "openai-codex/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
      },
    },
  },
}
```

會話覆寫優先於設定。在 Sessions UI 中清除會話覆寫，會將會話還原為設定的預設值。

### OpenAI 回應的伺服器端壓縮

對於直接使用 OpenAI 回應模型 (`openai/*` 使用 `api: "openai-responses"` 搭配 `baseUrl` 在 `api.openai.com` 上)，OpenClaw 現在會自動啟用 OpenAI 伺服器端壓縮的負載提示：

- 強制 `store: true`（除非模型相容性設定了 `supportsStore: false`）
- 注入 `context_management: [{ type: "compaction", compact_threshold: ... }]`

預設情況下，`compact_threshold` 是模型 `contextWindow` 的 `70%`（若無法取得則為 `80000`）。

### 明確啟用伺服器端壓縮

當你想強制在相容的回應模型上注入 `context_management` 時使用（例如 Azure OpenAI 回應）：

```json5
{
  agents: {
    defaults: {
      models: {
        "azure-openai-responses/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
          },
        },
      },
    },
  },
}
```

### 使用自訂閾值啟用

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
            responsesCompactThreshold: 120000,
          },
        },
      },
    },
  },
}
```

### 停用伺服器端壓縮

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

`responsesServerCompaction` 僅控制 `context_management` 的注入。直接的 OpenAI 回應模型仍會強制 `store: true`，除非相容性設定了 `supportsStore: false`。

## 備註

- 模型參考總是使用 `provider/model`（詳見 [/concepts/models](/concepts/models)）。
- 認證細節與重複使用規則請參考 [/concepts/oauth](/concepts/oauth)。
