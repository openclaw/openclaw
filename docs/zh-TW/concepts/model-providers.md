---
summary: Model provider overview with example configs + CLI flows
read_when:
  - You need a provider-by-provider model setup reference
  - You want example configs or CLI onboarding commands for model providers
title: Model Providers
---

# 模型提供者

本頁涵蓋 **大型語言模型/模型提供者**（非 WhatsApp/Telegram 等聊天頻道）。
關於模型選擇規則，請參考 [/concepts/models](/concepts/models)。

## 快速規則

- 模型參考使用 `provider/model`（範例：`opencode/claude-opus-4-6`）。
- 若設定 `agents.defaults.models`，則成為允許清單。
- CLI 輔助工具：`openclaw onboard`、`openclaw models list`、`openclaw models set <provider/model>`。

## API 金鑰輪替

- 支援針對特定提供者的通用金鑰輪替。
- 可透過以下方式設定多組金鑰：
  - `OPENCLAW_LIVE_<PROVIDER>_KEY`（單一即時覆蓋，優先權最高）
  - `<PROVIDER>_API_KEYS`（逗號或分號分隔清單）
  - `<PROVIDER>_API_KEY`（主要金鑰）
  - `<PROVIDER>_API_KEY_*`（編號清單，例如 `<PROVIDER>_API_KEY_1`）
- Google 提供者同時包含 `GOOGLE_API_KEY` 作為備援。
- 金鑰選擇順序會保留優先權並去除重複值。
- 僅在遇到速率限制回應時（例如 `429`、`rate_limit`、`quota`、`resource exhausted`）才會嘗試使用下一組金鑰重試請求。
- 非速率限制失敗會立即失敗，不會嘗試金鑰輪替。
- 當所有候選金鑰皆失敗時，最終錯誤會回傳最後一次嘗試的結果。

## 內建提供者（pi-ai 目錄）

OpenClaw 內建 pi‑ai 目錄。這些提供者不需設定 **`models.providers`**；只要設定認證並選擇模型即可。

### OpenAI

- 提供者：`openai`
- 認證：`OPENAI_API_KEY`
- 選用輪替：`OPENAI_API_KEYS`、`OPENAI_API_KEY_1`、`OPENAI_API_KEY_2`，以及 `OPENCLAW_LIVE_OPENAI_KEY`（單一覆蓋）
- 範例模型：`openai/gpt-5.4`、`openai/gpt-5.4-pro`
- CLI：`openclaw onboard --auth-choice openai-api-key`
- 預設傳輸為 `auto`（優先 WebSocket，備援 SSE）
- 可透過 `agents.defaults.models["openai/<model>"].params.transport` 針對單一模型覆蓋傳輸方式（`"sse"`、`"websocket"` 或 `"auto"`）
- OpenAI 回應 WebSocket 預設啟用暖機功能，透過 `params.openaiWsWarmup`（`true`/`false`）
- 可透過 `agents.defaults.models["openai/<model>"].params.serviceTier` 啟用 OpenAI 優先處理
- 可針對單一模型啟用 OpenAI 快速模式，透過 `agents.defaults.models["<provider>/<model>"].params.fastMode`
- `openai/gpt-5.3-codex-spark` 在 OpenClaw 中故意被抑制，因為即時 OpenAI API 會拒絕；Spark 僅視為 Codex 專用

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

### Anthropic

- 提供者：`anthropic`
- 認證：`ANTHROPIC_API_KEY` 或 `claude setup-token`
- 選用輪替：`ANTHROPIC_API_KEYS`、`ANTHROPIC_API_KEY_1`、`ANTHROPIC_API_KEY_2`，以及 `OPENCLAW_LIVE_ANTHROPIC_KEY`（單一覆蓋）
- 範例模型：`anthropic/claude-opus-4-6`
- CLI：`openclaw onboard --auth-choice token`（貼上 setup-token）或 `openclaw models auth paste-token --provider anthropic`
- 直接 API 金鑰模型支援共用 `/fast` 切換與 `params.fastMode`；OpenClaw 將其映射至 Anthropic 的 `service_tier`（`auto` 對比 `standard_only`）
- 政策說明：setup-token 支援為技術相容性；Anthropic 過去曾封鎖部分訂閱用戶在 Claude Code 以外的使用。請確認當前 Anthropic 條款並依風險承受度決定。
- 建議：Anthropic API 金鑰認證為較安全且推薦的方式，優於訂閱 setup-token 認證。

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- 提供者：`openai-codex`
- 認證：OAuth（ChatGPT）
- 範例模型：`openai-codex/gpt-5.4`
- CLI：`openclaw onboard --auth-choice openai-codex` 或 `openclaw models auth login --provider openai-codex`
- 預設傳輸為 `auto`（優先 WebSocket，備援 SSE）
- 可透過 `agents.defaults.models["openai-codex/<model>"].params.transport`（`"sse"`、`"websocket"` 或 `"auto"`）針對各模型覆寫
- 與直接 `openai/*` 共用相同的 `/fast` 切換與 `params.fastMode` 設定
- `openai-codex/gpt-5.3-codex-spark` 在 Codex OAuth 目錄開放時仍可使用；依權限而定
- 政策說明：OpenAI Codex OAuth 明確支援外部工具/工作流程，如 OpenClaw。

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

### OpenCode

- 認證：`OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`）
- Zen 執行環境提供者：`opencode`
- Go 執行環境提供者：`opencode-go`
- 範例模型：`opencode/claude-opus-4-6`、`opencode-go/kimi-k2.5`
- CLI：`openclaw onboard --auth-choice opencode-zen` 或 `openclaw onboard --auth-choice opencode-go`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini（API 金鑰）

- 提供者：`google`
- 認證：`GEMINI_API_KEY`
- 選用輪替：`GEMINI_API_KEYS`、`GEMINI_API_KEY_1`、`GEMINI_API_KEY_2`、`GOOGLE_API_KEY` 備援，以及 `OPENCLAW_LIVE_GEMINI_KEY`（單一覆寫）
- 範例模型：`google/gemini-3.1-pro-preview`、`google/gemini-3-flash-preview`
- 相容性：使用 `google/gemini-3.1-flash-preview` 的舊版 OpenClaw 設定會被標準化為 `google/gemini-3-flash-preview`
- CLI：`openclaw onboard --auth-choice gemini-api-key`

### Google Vertex、Antigravity 與 Gemini CLI

- 提供者：`google-vertex`、`google-antigravity`、`google-gemini-cli`
- 認證：Vertex 使用 gcloud ADC；Antigravity/Gemini CLI 使用各自的認證流程
- 注意：Antigravity 與 Gemini CLI OAuth 在 OpenClaw 中為非官方整合。有使用者反映使用第三方用戶端後 Google 帳號受限。請審閱 Google 條款，並建議使用非重要帳號以降低風險。
- Antigravity OAuth 以內建外掛形式提供（`google-antigravity-auth`，預設關閉）。
  - 啟用：`openclaw plugins enable google-antigravity-auth`
  - 登入：`openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth 以內建外掛形式提供（`google-gemini-cli-auth`，預設關閉）。
  - 啟用：`openclaw plugins enable google-gemini-cli-auth`
  - 登入：`openclaw models auth login --provider google-gemini-cli --set-default`
  - 注意：您**不需**將 client id 或 secret 貼入 `openclaw.json`。CLI 登入流程會將 token 儲存在閘道主機的認證設定檔中。

### Z.AI（GLM）

- 提供者：`zai`
- 認證：`ZAI_API_KEY`
- 範例模型：`zai/glm-5`
- CLI：`openclaw onboard --auth-choice zai-api-key`
  - 別名：`z.ai/*` 和 `z-ai/*` 會標準化為 `zai/*`

### Vercel AI Gateway

- 提供者：`vercel-ai-gateway`
- 認證：`AI_GATEWAY_API_KEY`
- 範例模型：`vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI：`openclaw onboard --auth-choice ai-gateway-api-key`

### Kilo Gateway

- 提供者：`kilocode`
- 認證：`KILOCODE_API_KEY`
- 範例模型：`kilocode/anthropic/claude-opus-4.6`
- CLI：`openclaw onboard --kilocode-api-key <key>`
- 基本 URL：`https://api.kilo.ai/api/gateway/`
- 擴充內建目錄包含 GLM-5 Free、MiniMax M2.5 Free、GPT-5.2、Gemini 3 Pro Preview、Gemini 3 Flash Preview、Grok Code Fast 1 及 Kimi K2.5。

請參考 [/providers/kilocode](/providers/kilocode) 以取得設定詳情。

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
  - Cerebras 上的 GLM 模型使用 ID `zai-glm-4.7` 和 `zai-glm-4.6`。
  - OpenAI 相容的基底 URL: `https://api.cerebras.ai/v1`。
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)
- Hugging Face 推論: `huggingface` (`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`) — OpenAI 相容的路由器；範例模型: `huggingface/deepseek-ai/DeepSeek-R1`；CLI: `openclaw onboard --auth-choice huggingface-api-key`。詳見 [Hugging Face (Inference)](/providers/huggingface)。

## 透過 `models.providers` (自訂/基底 URL) 的提供者

使用 `models.providers`（或 `models.json`）來新增 **自訂** 提供者或 OpenAI/Anthropic 相容的代理。

### Moonshot AI (Kimi)

Moonshot 使用 OpenAI 相容的端點，因此請將其設定為自訂提供者：

- 提供者: `moonshot`
- 認證: `MOONSHOT_API_KEY`
- 範例模型: `moonshot/kimi-k2.5`

Kimi K2 模型 ID：

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

- 供應商：`kimi-coding`
- 認證：`KIMI_API_KEY`
- 範例模型：`kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth（免費方案）

Qwen 透過裝置碼流程提供 Qwen Coder + Vision 的 OAuth 存取。
啟用內建插件後，進行登入：

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

模型參考：

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

詳情與設定說明請參考 [/providers/qwen](/providers/qwen)。

### 火山引擎（Doubao）

火山引擎提供中國地區 Doubao 及其他模型的存取。

- 供應商：`volcengine`（程式碼：`volcengine-plan`）
- 認證：`VOLCANO_ENGINE_API_KEY`
- 範例模型：`volcengine/doubao-seed-1-8-251228`
- CLI：`openclaw onboard --auth-choice volcengine-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "volcengine/doubao-seed-1-8-251228" } },
  },
}
```

可用模型：

- `volcengine/doubao-seed-1-8-251228`（Doubao Seed 1.8）
- `volcengine/doubao-seed-code-preview-251028`
- `volcengine/kimi-k2-5-260127`（Kimi K2.5）
- `volcengine/glm-4-7-251222`（GLM 4.7）
- `volcengine/deepseek-v3-2-251201`（DeepSeek V3.2 128K）

程式碼模型 (`volcengine-plan`)：

- `volcengine-plan/ark-code-latest`
- `volcengine-plan/doubao-seed-code`
- `volcengine-plan/kimi-k2.5`
- `volcengine-plan/kimi-k2-thinking`
- `volcengine-plan/glm-4.7`

### BytePlus（國際版）

BytePlus ARK 為國際用戶提供與 Volcano Engine 相同的模型存取。

- 供應商：`byteplus`（程式碼模型：`byteplus-plan`）
- 認證：`BYTEPLUS_API_KEY`
- 範例模型：`byteplus/seed-1-8-251228`
- CLI：`openclaw onboard --auth-choice byteplus-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "byteplus/seed-1-8-251228" } },
  },
}
```

可用模型：

- `byteplus/seed-1-8-251228`（Seed 1.8）
- `byteplus/kimi-k2-5-260127`（Kimi K2.5）
- `byteplus/glm-4-7-251222`（GLM 4.7）

程式碼模型 (`byteplus-plan`)：

- `byteplus-plan/ark-code-latest`
- `byteplus-plan/doubao-seed-code`
- `byteplus-plan/kimi-k2.5`
- `byteplus-plan/kimi-k2-thinking`
- `byteplus-plan/glm-4.7`

### Synthetic

Synthetic 透過 `synthetic` 供應商提供相容於 Anthropic 的模型：

- 供應商：`synthetic`
- 認證：`SYNTHETIC_API_KEY`
- 範例模型：`synthetic/hf:MiniMaxAI/MiniMax-M2.5`
- CLI：`openclaw onboard --auth-choice synthetic-api-key`

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

MiniMax 是透過 `models.providers` 進行設定，因為它使用自訂端點：

- MiniMax（相容 Anthropic）：`--auth-choice minimax-api`
- 認證：`MINIMAX_API_KEY`

詳細設定、模型選項及設定範例請參考 [/providers/minimax](/providers/minimax)。

### Ollama

Ollama 以內建提供者外掛形式提供，並使用 Ollama 的原生 API：

- 提供者：`ollama`
- 認證：不需要（本地伺服器）
- 範例模型：`ollama/llama3.3`
- 安裝： [https://ollama.com/download](https://ollama.com/download)

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

當你選擇 `OLLAMA_API_KEY` 時，Ollama 會在本地於 `http://127.0.0.1:11434` 被偵測到，內建提供者外掛會直接將 Ollama 加入 `openclaw onboard` 及模型選擇器。更多上手、雲端/本地模式及自訂設定請參考 [/providers/ollama](/providers/ollama)。

### vLLM

vLLM 以內建提供者外掛形式提供，適用於本地或自架的相容 OpenAI 伺服器：

- 提供者：`vllm`
- 認證：可選（視伺服器而定）
- 預設基底 URL：`http://127.0.0.1:8000/v1`

若要在本地啟用自動偵測（若伺服器不強制認證，任何值皆可）：

```bash
export VLLM_API_KEY="vllm-local"
```

接著設定模型（請替換為 `/v1/models` 回傳的其中一個 ID）：

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

詳情請參考 [/providers/vllm](/providers/vllm)。

### SGLang

SGLang 以捆綁的提供者外掛形式發佈，適用於快速自架的
OpenAI 相容伺服器：

- 提供者：`sglang`
- 認證：可選（視您的伺服器而定）
- 預設基底 URL：`http://127.0.0.1:30000/v1`

若要在本地啟用自動偵測（若您的伺服器不強制認證，任何值皆可）：

```bash
export SGLANG_API_KEY="sglang-local"
```

接著設定模型（請替換為 `/v1/models` 回傳的其中一個 ID）：

```json5
{
  agents: {
    defaults: { model: { primary: "sglang/your-model-id" } },
  },
}
```

詳情請參考 [/providers/sglang](/providers/sglang)。

### 本地代理（LM Studio、vLLM、LiteLLM 等）

範例（OpenAI 相容）：

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

注意事項：

- 對於自訂提供者，`reasoning`、`input`、`cost`、`contextWindow` 和 `maxTokens` 為可選。
  若省略，OpenClaw 預設為：
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 建議設定與您的代理/模型限制相符的明確值。
- 對於非原生端點的 `api: "openai-completions"`（任何非空且主機非 `api.openai.com` 的 `baseUrl`），OpenClaw 強制使用 `compat.supportsDeveloperRole: false`，以避免提供者因不支援的 `developer` 角色而產生 400 錯誤。
- 若 `baseUrl` 為空或省略，OpenClaw 將維持預設的 OpenAI 行為（解析為 `api.openai.com`）。
- 為安全起見，非原生 `openai-completions` 端點仍會覆寫明確設定的 `compat.supportsDeveloperRole: true`。

## CLI 範例

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

另請參考：[/gateway/configuration](/gateway/configuration) 以取得完整的設定範例。
