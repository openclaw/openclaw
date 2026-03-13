---
summary: Model provider overview with example configs + CLI flows
read_when:
  - You need a provider-by-provider model setup reference
  - You want example configs or CLI onboarding commands for model providers
title: Model Providers
---

# Model providers

此頁面涵蓋 **LLM/模型提供者**（而非像 WhatsApp/Telegram 這樣的聊天頻道）。  
有關模型選擇規則，請參見 [/concepts/models](/concepts/models)。

## Quick rules

- 模型參考使用 `provider/model`（範例：`opencode/claude-opus-4-6`）。
- 如果您設定 `agents.defaults.models`，它將成為允許清單。
- CLI 幫助工具：`openclaw onboard`、`openclaw models list`、`openclaw models set <provider/model>`。

## API 金鑰輪替

- 支援選定提供者的通用提供者輪換。
- 可透過以下方式設定多個金鑰：
  - `OPENCLAW_LIVE_<PROVIDER>_KEY`（單一即時覆蓋，最高優先權）
  - `<PROVIDER>_API_KEYS`（以逗號或分號分隔的清單）
  - `<PROVIDER>_API_KEY`（主要金鑰）
  - `<PROVIDER>_API_KEY_*`（編號清單，例如 `<PROVIDER>_API_KEY_1`）
- 對於 Google 提供者，`GOOGLE_API_KEY` 也作為備援包含在內。
- 金鑰選擇順序保留優先權並去除重複值。
- 只有在速率限制回應時（例如 `429`、`rate_limit`、`quota`、`resource exhausted`）才會使用下一個金鑰重試請求。
- 非速率限制的失敗會立即失敗；不會嘗試金鑰輪換。
- 當所有候選金鑰失敗時，將返回最後一次嘗試的最終錯誤。

## 內建提供者 (pi-ai 目錄)

OpenClaw 附帶 pi‑ai 目錄。這些提供者**不需要** `models.providers` 設定；只需設置認證並選擇一個模型。

### OpenAI

- 提供者: `openai`
- 認證: `OPENAI_API_KEY`
- 可選的輪換: `OPENAI_API_KEYS`, `OPENAI_API_KEY_1`, `OPENAI_API_KEY_2`，加上 `OPENCLAW_LIVE_OPENAI_KEY`（單一覆蓋）
- 範例模型: `openai/gpt-5.4`, `openai/gpt-5.4-pro`
- CLI: `openclaw onboard --auth-choice openai-api-key`
- 預設傳輸為 `auto`（優先使用 WebSocket，SSE 作為備援）
- 每個模型的覆蓋可透過 `agents.defaults.models["openai/<model>"].params.transport` 進行 (`"sse"`, `"websocket"`, 或 `"auto"`)
- OpenAI 回應的 WebSocket 預熱預設為啟用，透過 `params.openaiWsWarmup` (`true`/`false`)
- OpenAI 優先處理可透過 `agents.defaults.models["openai/<model>"].params.serviceTier` 啟用
- OpenAI 快速模式可透過每個模型的 `agents.defaults.models["<provider>/<model>"].params.fastMode` 啟用
- `openai/gpt-5.3-codex-spark` 在 OpenClaw 中被故意抑制，因為即時的 OpenAI API 拒絕它；Spark 被視為僅限 Codex

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

### Anthropic

- 提供者: `anthropic`
- 認證: `ANTHROPIC_API_KEY` 或 `claude setup-token`
- 可選的輪換: `ANTHROPIC_API_KEYS`, `ANTHROPIC_API_KEY_1`, `ANTHROPIC_API_KEY_2`, 以及 `OPENCLAW_LIVE_ANTHROPIC_KEY`（單一覆蓋）
- 範例模型: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token`（貼上 setup-token）或 `openclaw models auth paste-token --provider anthropic`
- 直接 API 金鑰模型支援共享 `/fast` 切換和 `params.fastMode`；OpenClaw 將其映射到 Anthropic `service_tier` (`auto` 與 `standard_only`)
- 政策說明: setup-token 支援是技術相容性；Anthropic 過去已經封鎖了一些訂閱在 Claude Code 之外的使用。請確認當前的 Anthropic 條款並根據您的風險承受能力做出決定。
- 建議: Anthropic API 金鑰認證是比訂閱 setup-token 認證更安全、推薦的路徑。

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI 程式碼 (Codex)

- 提供者: `openai-codex`
- 認證: OAuth (ChatGPT)
- 範例模型: `openai-codex/gpt-5.4`
- CLI: `openclaw onboard --auth-choice openai-codex` 或 `openclaw models auth login --provider openai-codex`
- 預設傳輸為 `auto` (優先使用 WebSocket，SSE 作為備援)
- 可透過 `agents.defaults.models["openai-codex/<model>"].params.transport` 針對每個模型進行覆寫 (`"sse"`, `"websocket"`, 或 `"auto"`)
- 與直接 `openai/*` 共享相同的 `/fast` 切換和 `params.fastMode` 設定
- `openai-codex/gpt-5.3-codex-spark` 在 Codex OAuth 目錄公開時仍然可用；依賴於權限
- 政策說明: OpenAI Codex OAuth 明確支援外部工具/工作流程，如 OpenClaw。

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

### OpenCode

- 認證: `OPENCODE_API_KEY` (或 `OPENCODE_ZEN_API_KEY`)
- Zen 執行環境提供者: `opencode`
- Go 執行環境提供者: `opencode-go`
- 範例模型: `opencode/claude-opus-4-6`, `opencode-go/kimi-k2.5`
- CLI: `openclaw onboard --auth-choice opencode-zen` 或 `openclaw onboard --auth-choice opencode-go`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API 金鑰)

- 提供者: `google`
- 認證: `GEMINI_API_KEY`
- 可選的輪換: `GEMINI_API_KEYS`, `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, `GOOGLE_API_KEY` 備用，以及 `OPENCLAW_LIVE_GEMINI_KEY` (單一覆蓋)
- 範例模型: `google/gemini-3.1-pro-preview`, `google/gemini-3-flash-preview`
- 相容性: 使用 `google/gemini-3.1-flash-preview` 的舊版 OpenClaw 設定已標準化為 `google/gemini-3-flash-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity, 和 Gemini CLI

- 提供者: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- 認證: Vertex 使用 gcloud ADC；Antigravity/Gemini CLI 使用各自的認證流程
- 注意: Antigravity 和 Gemini CLI 的 OAuth 在 OpenClaw 中是非官方整合。一些使用者在使用第三方用戶端後報告了 Google 帳戶的限制。如果您選擇繼續，請檢查 Google 的條款並使用非關鍵帳戶。
- Antigravity OAuth 作為捆綁插件發佈 (`google-antigravity-auth`，預設為禁用)。
  - 啟用: `openclaw plugins enable google-antigravity-auth`
  - 登入: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth 作為捆綁插件發佈 (`google-gemini-cli-auth`，預設為禁用)。
  - 啟用: `openclaw plugins enable google-gemini-cli-auth`
  - 登入: `openclaw models auth login --provider google-gemini-cli --set-default`
  - 注意: 您**不**需要將用戶端 ID 或密鑰貼入 `openclaw.json`。CLI 登入流程會將 token 儲存在網關主機的認證設定檔中。

### Z.AI (GLM)

- 提供者: `zai`
- 認證: `ZAI_API_KEY`
- 範例模型: `zai/glm-5`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - 別名: `z.ai/*` 和 `z-ai/*` 正規化為 `zai/*`

### Vercel AI Gateway

- 提供者: `vercel-ai-gateway`
- 認證: `AI_GATEWAY_API_KEY`
- 範例模型: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Kilo Gateway

- 提供者: `kilocode`
- 認證: `KILOCODE_API_KEY`
- 範例模型: `kilocode/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --kilocode-api-key <key>`
- 基本 URL: `https://api.kilo.ai/api/gateway/`
- 擴充的內建目錄包括 GLM-5 Free、MiniMax M2.5 Free、GPT-5.2、Gemini 3 Pro Preview、Gemini 3 Flash Preview、Grok Code Fast 1 和 Kimi K2.5。

請參閱 [/providers/kilocode](/providers/kilocode) 以獲取設置詳細資訊。

### 其他內建提供者

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- 範例模型: `openrouter/anthropic/claude-sonnet-4-5`
- Kilo Gateway: `kilocode` (`KILOCODE_API_KEY`)
- 範例模型: `kilocode/anthropic/claude-opus-4.6`
- xAI: `xai` (`XAI_API_KEY`)
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- 範例模型: `mistral/mistral-large-latest`
- CLI: `openclaw onboard --auth-choice mistral-api-key`
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras 上的 GLM 模型使用 ids `zai-glm-4.7` 和 `zai-glm-4.6`。
  - OpenAI 相容的基本 URL: `https://api.cerebras.ai/v1`。
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)
- Hugging Face 推論: `huggingface` (`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`) — OpenAI 相容的路由器；範例模型: `huggingface/deepseek-ai/DeepSeek-R1`；CLI: `openclaw onboard --auth-choice huggingface-api-key`。請參見 [Hugging Face (推論)](/providers/huggingface)。

## 透過 `models.providers` (自訂/基本 URL) 提供者

使用 `models.providers` (或 `models.json`) 來添加 **自訂** 提供者或 OpenAI/Anthropic 兼容的代理。

### Moonshot AI (Kimi)

Moonshot 使用與 OpenAI 兼容的端點，因此將其設定為自定義提供者：

- 提供者: `moonshot`
- 認證: `MOONSHOT_API_KEY`
- 範例模型: `moonshot/kimi-k2.5`

Kimi K2 型號 ID：

<!-- markdownlint-disable MD037 -->

{/_ moonshot-kimi-k2-model-refs:start _/ && null}

<!-- markdownlint-enable MD037 -->

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-0905-preview`
- `moonshot/kimi-k2-turbo-preview`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
  <!-- markdownlint-disable MD037 -->
  {/_ moonshot-kimi-k2-model-refs:end _/ && null}
  <!-- markdownlint-enable MD037 -->

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
}
```

### Kimi Coding

Kimi Coding 使用 Moonshot AI 的 Anthropic 相容端點：

- 提供者: `kimi-coding`
- 認證: `KIMI_API_KEY`
- 範例模型: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (免費方案)

Qwen 提供透過設備碼流程的 OAuth 存取 Qwen Coder + Vision。啟用捆綁的插件，然後登入：

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

Model refs:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

請參閱 [/providers/qwen](/providers/qwen) 以獲取設置詳細資訊和注意事項。

### Volcano Engine (Doubao)

Volcano Engine (火山引擎) 提供對中國的 Doubao 及其他模型的訪問。

- 提供者: `volcengine` (編碼: `volcengine-plan`)
- 認證: `VOLCANO_ENGINE_API_KEY`
- 範例模型: `volcengine/doubao-seed-1-8-251228`
- CLI: `openclaw onboard --auth-choice volcengine-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "volcengine/doubao-seed-1-8-251228" } },
  },
}
```

可用的模型：

- `volcengine/doubao-seed-1-8-251228` (豆包種子 1.8)
- `volcengine/doubao-seed-code-preview-251028`
- `volcengine/kimi-k2-5-260127` (Kimi K2.5)
- `volcengine/glm-4-7-251222` (GLM 4.7)
- `volcengine/deepseek-v3-2-251201` (DeepSeek V3.2 128K)

Coding models (`volcengine-plan`):

- `volcengine-plan/ark-code-latest`
- `volcengine-plan/doubao-seed-code`
- `volcengine-plan/kimi-k2.5`
- `volcengine-plan/kimi-k2-thinking`
- `volcengine-plan/glm-4.7`

### BytePlus (國際)

BytePlus ARK 為國際用戶提供與 Volcano Engine 相同的模型存取。

- 提供者: `byteplus` (編碼: `byteplus-plan`)
- 認證: `BYTEPLUS_API_KEY`
- 範例模型: `byteplus/seed-1-8-251228`
- CLI: `openclaw onboard --auth-choice byteplus-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "byteplus/seed-1-8-251228" } },
  },
}
```

可用的模型：

- `byteplus/seed-1-8-251228` (Seed 1.8)
- `byteplus/kimi-k2-5-260127` (Kimi K2.5)
- `byteplus/glm-4-7-251222` (GLM 4.7)

Coding models (`byteplus-plan`):

- `byteplus-plan/ark-code-latest`
- `byteplus-plan/doubao-seed-code`
- `byteplus-plan/kimi-k2.5`
- `byteplus-plan/kimi-k2-thinking`
- `byteplus-plan/glm-4.7`

### Synthetic

Synthetic 提供與 Anthropic 兼容的模型，透過 `synthetic` 供應商提供：

- Provider: `synthetic`
- Auth: `SYNTHETIC_API_KEY`
- Example model: `synthetic/hf:MiniMaxAI/MiniMax-M2.5`
- CLI: `openclaw onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5" }],
      },
    },
  },
}
```

### MiniMax

MiniMax 是透過 `models.providers` 進行設定的，因為它使用自訂的端點：

- MiniMax (與Anthropic相容): `--auth-choice minimax-api`
- 認證: `MINIMAX_API_KEY`

請參閱 [/providers/minimax](/providers/minimax) 以獲取設置詳細資訊、模型選項和設定片段。

### Ollama

Ollama 作為一個捆綁的提供者插件發佈，並使用 Ollama 的原生 API：

- 提供者: `ollama`
- 認證: 不需要（本地伺服器）
- 範例模型: `ollama/llama3.3`
- 安裝: [https://ollama.com/download](https://ollama.com/download)

```bash
# Install Ollama, then pull a model:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

Ollama 在您選擇 `OLLAMA_API_KEY` 時會在 `http://127.0.0.1:11434` 本地檢測到，並且捆綁的提供者插件會直接將 Ollama 添加到 `openclaw onboard` 和模型選擇器中。請參閱 [/providers/ollama](/providers/ollama) 以獲取入門、雲端/本地模式和自訂設定的資訊。

### vLLM

vLLM 作為一個捆綁的提供者插件，適用於本地/自我託管的 OpenAI 相容伺服器：

- 提供者: `vllm`
- 認證: 可選（取決於您的伺服器）
- 預設基本 URL: `http://127.0.0.1:8000/v1`

要在本地啟用自動發現（如果您的伺服器不強制身份驗證，任何值都可以）：

```bash
export VLLM_API_KEY="vllm-local"
```

然後設置一個模型（用 `/v1/models` 返回的其中一個 ID 替換）：

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

請參閱 [/providers/vllm](/providers/vllm) 以獲取詳細資訊。

### SGLang

SGLang 作為一個捆綁的提供者插件，快速支援自我託管的 OpenAI 相容伺服器：

- 提供者: `sglang`
- 認證: 可選（取決於您的伺服器）
- 預設基本 URL: `http://127.0.0.1:30000/v1`

要在本地啟用自動發現（如果您的伺服器不強制驗證，任何值都可以）：

```bash
export SGLANG_API_KEY="sglang-local"
```

然後設置一個模型（用 `/v1/models` 返回的其中一個 ID 替換）：

```json5
{
  agents: {
    defaults: { model: { primary: "sglang/your-model-id" } },
  },
}
```

請參閱 [/providers/sglang](/providers/sglang) 以獲取詳細資訊。

### 本地代理 (LM Studio, vLLM, LiteLLM 等)

範例 (OpenAI 兼容)：

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.5-gs32" },
      models: { "lmstudio/minimax-m2.5-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LMSTUDIO_KEY",
        api: "openai-completions",
        models: [
          {
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

[[BLOCK_1]]

- 對於自訂提供者，`reasoning`、`input`、`cost`、`contextWindow` 和 `maxTokens` 是可選的。  
  當省略時，OpenClaw 預設為：
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 建議：設置與您的代理/模型限制相符的明確值。
- 對於非原生端點上的 `api: "openai-completions"`（任何非空的 `baseUrl` 其主機不是 `api.openai.com`），OpenClaw 強制 `compat.supportsDeveloperRole: false` 以避免提供者 400 錯誤，因為不支援的 `developer` 角色。
- 如果 `baseUrl` 為空/省略，OpenClaw 將保持預設的 OpenAI 行為（解析為 `api.openai.com`）。
- 為了安全起見，明確的 `compat.supportsDeveloperRole: true` 在非原生 `openai-completions` 端點上仍然會被覆蓋。

## CLI 範例

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

另請參閱 [/gateway/configuration](/gateway/configuration) 以獲取完整的設定範例。
