---
summary: "模型供應商概覽，包含設定範例與 CLI 流程"
read_when:
  - "當你需要各個供應商的模型設定參考時"
  - "當你需要模型供應商的設定範例或 CLI 新手導覽指令時"
title: "模型供應商"
---

# 模型供應商

本頁面涵蓋 **LLM/模型供應商**（並非如 WhatsApp/Telegram 等聊天頻道）。
關於模型選擇規則，請參閱 [/concepts/models](/concepts/models)。

## 快速規則

- 模型引用格式為 `provider/model`（例如：`opencode/claude-opus-4-6`）。
- 如果你設定了 `agents.defaults.models`，它將成為允許清單（allowlist）。
- CLI 輔助指令：`openclaw onboard`、`openclaw models list`、`openclaw models set <provider/model>`。

## 內建供應商 (pi-ai 目錄)

OpenClaw 隨附 pi-ai 目錄。這些供應商不需要 `models.providers` 設定；只需設定憑證並選擇模型即可。

### OpenAI

- 供應商：`openai`
- 憑證：`OPENAI_API_KEY`
- 範例模型：`openai/gpt-5.1-codex`
- CLI：`openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- 供應商：`anthropic`
- 憑證：`ANTHROPIC_API_KEY` 或 `claude setup-token`
- 範例模型：`anthropic/claude-opus-4-6`
- CLI：`openclaw onboard --auth-choice token`（貼上 setup-token）或 `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- 供應商：`openai-codex`
- 憑證：OAuth (ChatGPT)
- 範例模型：`openai-codex/gpt-5.3-codex`
- CLI：`openclaw onboard --auth-choice openai-codex` 或 `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- 供應商：`opencode`
- 憑證：`OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`）
- 範例模型：`opencode/claude-opus-4-6`
- CLI：`openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API key)

- 供應商：`google`
- 憑證：`GEMINI_API_KEY`
- 範例模型：`google/gemini-3-pro-preview`
- CLI：`openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity, and Gemini CLI

- 供應商：`google-vertex`、`google-antigravity`、`google-gemini-cli`
- 憑證：Vertex 使用 gcloud ADC；Antigravity/Gemini CLI 使用各自的認證流程
- Antigravity OAuth 以隨附外掛形式提供 (`google-antigravity-auth`，預設為停用)。
  - 啟用：`openclaw plugins enable google-antigravity-auth`
  - 登入：`openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth 以隨附外掛形式提供 (`google-gemini-cli-auth`，預設為停用)。
  - 啟用：`openclaw plugins enable google-gemini-cli-auth`
  - 登入：`openclaw models auth login --provider google-gemini-cli --set-default`
  - 注意：你 **不需要** 將 client id 或 secret 貼上到 `openclaw.json`。CLI 登入流程會將憑證儲存在 Gateway 主機上的認證設定檔中。

### Z.AI (GLM)

- 供應商：`zai`
- 憑證：`ZAI_API_KEY`
- 範例模型：`zai/glm-4.7`
- CLI：`openclaw onboard --auth-choice zai-api-key`
  - 別名：`z.ai/*` 與 `z-ai/*` 會標準化為 `zai/*`

### Vercel AI Gateway

- 供應商：`vercel-ai-gateway`
- 憑證：`AI_GATEWAY_API_KEY`
- 範例模型：`vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI：`openclaw onboard --auth-choice ai-gateway-api-key`

### 其他內建供應商

- OpenRouter：`openrouter` (`OPENROUTER_API_KEY`)
- 範例模型：`openrouter/anthropic/claude-sonnet-4-5`
- xAI：`xai` (`XAI_API_KEY`)
- Groq：`groq` (`GROQ_API_KEY`)
- Cerebras：`cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras 上的 GLM 模型使用 ID `zai-glm-4.7` 與 `zai-glm-4.6`。
  - 相容 OpenAI 的基礎 URL：`https://api.cerebras.ai/v1`。
- Mistral：`mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot：`github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)
- Hugging Face Inference：`huggingface` (`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`) — 相容 OpenAI 的路由；範例模型：`huggingface/deepseek-ai/DeepSeek-R1`；CLI：`openclaw onboard --auth-choice huggingface-api-key`。請參閱 [Hugging Face (Inference)](/providers/huggingface)。

## 透過 `models.providers` 設定的供應商（自定義/基礎 URL）

使用 `models.providers`（或 `models.json`）來新增 **自定義** 供應商，或相容 OpenAI/Anthropic 的代理伺服器。

### Moonshot AI (Kimi)

Moonshot 使用相容 OpenAI 的端點，因此請將其設定為自定義供應商：

- 供應商：`moonshot`
- 憑證：`MOONSHOT_API_KEY`
- 範例模型：`moonshot/kimi-k2.5`

Kimi K2 模型 ID：

{/_moonshot-kimi-k2-model-refs:start_/ && null}

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-0905-preview`
- `moonshot/kimi-k2-turbo-preview`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-model-refs:end_/ && null}

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

Kimi Coding 使用 Moonshot AI 相容 Anthropic 的端點：

- 供應商：`kimi-coding`
- 憑證：`KIMI_API_KEY`
- 範例模型：`kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (免費版)

Qwen 透過裝置代碼流程提供對 Qwen Coder + Vision 的 OAuth 存取。請啟用隨附外掛，然後登入：

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

模型引用：

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

請參閱 [/providers/qwen](/providers/qwen) 瞭解設定詳情與注意事項。

### Synthetic

Synthetic 在 `synthetic` 供應商下提供相容 Anthropic 的模型：

- 供應商：`synthetic`
- 憑證：`SYNTHETIC_API_KEY`
- 範例模型：`synthetic/hf:MiniMaxAI/MiniMax-M2.1`
- CLI：`openclaw onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.1", name: "MiniMax M2.1" }],
      },
    },
  },
}
```

### MiniMax

MiniMax 是透過 `models.providers` 設定的，因為它使用自定義端點：

- MiniMax (相容 Anthropic)：`--auth-choice minimax-api`
- 憑證：`MINIMAX_API_KEY`

請參閱 [/providers/minimax](/providers/minimax) 瞭解設定詳情、模型選項以及設定片段。

### Ollama

Ollama 是一個本地 LLM 執行環境，提供相容 OpenAI 的 API：

- 供應商：`ollama`
- 憑證：不需要（本地伺服器）
- 範例模型：`ollama/llama3.3`
- 安裝：[https://ollama.ai](https://ollama.ai)

```bash
# 安裝 Ollama，然後拉取模型：
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

當在本地運行於 `http://127.0.0.1:11434/v1` 時，會自動偵測到 Ollama。請參閱 [/providers/ollama](/providers/ollama) 瞭解模型推薦與自定義設定。

### vLLM

vLLM 是一個本地（或自行代管）且相容 OpenAI 的伺服器：

- 供應商：`vllm`
- 憑證：選填（取決於你的伺服器）
- 預設基礎 URL：`http://127.0.0.1:8000/v1`

若要在本地啟用自動偵測（如果你的伺服器不強制執行認證，任何值皆可）：

```bash
export VLLM_API_KEY="vllm-local"
```

然後設定模型（請替換為 `/v1/models` 回傳的其中一個 ID）：

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

請參閱 [/providers/vllm](/providers/vllm) 瞭解詳情。

### 本地代理伺服器 (LM Studio, vLLM, LiteLLM 等)

範例 (相容 OpenAI)：

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1",
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

- 對於自定義供應商，`reasoning`、`input`、`cost`、`contextWindow` 以及 `maxTokens` 為選填。
  若省略，OpenClaw 將預設為：
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 建議：設定與你的代理伺服器/模型限制相符的明確數值。

## CLI 範例

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

另請參閱：[/gateway/configuration](/gateway/configuration) 以獲取完整的設定範例。
