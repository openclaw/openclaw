---
summary: "模型供應商概覽，包含範例設定與 CLI 流程"
read_when:
  - 您需要按供應商分類的模型設定參考
  - 您想要模型供應商的範例設定或 CLI 新手導覽指令
title: "模型供應商"
---

# 模型供應商

此頁面涵蓋 **LLM/模型供應商**（而非像 WhatsApp/Telegram 這類的聊天頻道）。
有關模型選擇規則，請參閱 [/concepts/models](/concepts/models)。

## 快速規則

- 模型參考使用 `供應商/模型` (範例: `opencode/claude-opus-4-6`)。
- 如果您設定 `agents.defaults.models`，它將成為允許清單。
- CLI 協助工具：`openclaw onboard`、`openclaw models list`、`openclaw models set <provider/model>`。

## 內建供應商 (pi-ai 目錄)

OpenClaw 內建 pi‑ai 目錄。這些供應商**無需**
`models.providers` 設定；只需設定憑證並選擇一個模型。

### OpenAI

- 供應商: `openai`
- 憑證: `OPENAI_API_KEY`
- 範例模型: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- 供應商: `anthropic`
- 憑證: `ANTHROPIC_API_KEY` 或 `claude setup-token`
- 範例模型: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (貼上 setup-token) 或 `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- 供應商: `openai-codex`
- 憑證: OAuth (ChatGPT)
- 範例模型: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` 或 `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- 供應商: `opencode`
- 憑證: `OPENCODE_API_KEY` (或 `OPENCODE_ZEN_API_KEY`)
- 範例模型: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API 金鑰)

- 供應商: `google`
- 憑證: `GEMINI_API_KEY`
- 範例模型: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity 和 Gemini CLI

- 供應商: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- 憑證: Vertex 使用 gcloud ADC；Antigravity/Gemini CLI 使用各自的憑證流程
- Antigravity OAuth 作為捆綁外掛程式 (`google-antigravity-auth`) 提供，預設為停用。
  - 啟用: `openclaw plugins enable google-antigravity-auth`
  - 登入: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth 作為捆綁外掛程式 (`google-gemini-cli-auth`) 提供，預設為停用。
  - 啟用: `openclaw plugins enable google-gemini-cli-auth`
  - 登入: `openclaw models auth login --provider google-gemini-cli --set-default`
  - 注意: 您**無須**將 client id 或 secret 貼上到 `openclaw.json` 中。CLI 登入流程會將
    token 儲存在 Gateway 主機上的憑證設定檔中。

### Z.AI (GLM)

- 供應商: `zai`
- 憑證: `ZAI_API_KEY`
- 範例模型: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - 別名: `z.ai/*` 和 `z-ai/*` 會正規化為 `zai/*`

### Vercel AI Gateway

- 供應商: `vercel-ai-gateway`
- 憑證: `AI_GATEWAY_API_KEY`
- 範例模型: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### 其他內建供應商

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- 範例模型: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras 上的 GLM 模型使用 ID `zai-glm-4.7` 和 `zai-glm-4.6`。
  - 相容 OpenAI 的基礎 URL: `https://api.cerebras.ai/v1`。
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)
- Hugging Face Inference: `huggingface` (`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`) — 相容 OpenAI 的路由器；範例模型: `huggingface/deepseek-ai/DeepSeek-R1`；CLI: `openclaw onboard --auth-choice huggingface-api-key`。請參閱 [Hugging Face (Inference)](/providers/huggingface)。

## 透過 `models.providers` 設定供應商 (自訂/基礎 URL)

使用 `models.providers` (或 `models.json`) 來新增**自訂**供應商或
相容 OpenAI/Anthropic 的代理。

### Moonshot AI (Kimi)

Moonshot 使用相容 OpenAI 的端點，因此將其設定為自訂供應商:

- 供應商: `moonshot`
- 憑證: `MOONSHOT_API_KEY`
- 範例模型: `moonshot/kimi-k2.5`

Kimi K2 模型 ID:

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

Kimi Coding 使用 Moonshot AI 相容 Anthropic 的端點:

- 供應商: `kimi-coding`
- 憑證: `KIMI_API_KEY`
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

Qwen 透過裝置代碼流程提供 Qwen Coder + Vision 的 OAuth 存取權限。
啟用捆綁外掛程式，然後登入:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

模型參考:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

有關設定細節和注意事項，請參閱 [/providers/qwen](/providers/qwen)。

### Synthetic

Synthetic 在 `synthetic` 供應商背後提供相容 Anthropic 的模型:

- 供應商: `synthetic`
- 憑證: `SYNTHETIC_API_KEY`
- 範例模型: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
- CLI: `openclaw onboard --auth-choice synthetic-api-key`

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

MiniMax 透過 `models.providers` 設定，因為它使用自訂端點:

- MiniMax (相容 Anthropic): `--auth-choice minimax-api`
- 憑證: `MINIMAX_API_KEY`

有關設定細節、模型選項和設定片段，請參閱 [/providers/minimax](/providers/minimax)。

### Ollama

Ollama 是一個提供相容 OpenAI API 的本機 LLM 執行環境:

- 供應商: `ollama`
- 憑證: 無需 (本機伺服器)
- 範例模型: `ollama/llama3.3`
- 安裝: [https://ollama.ai](https://ollama.ai)

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

當 Ollama 在本機 `http://127.0.0.1:11434/v1` 執行時會自動偵測到。有關模型建議和自訂設定，請參閱 [/providers/ollama](/providers/ollama)。

### vLLM

vLLM 是一個本機 (或自行託管) 相容 OpenAI 的伺服器:

- 供應商: `vllm`
- 憑證: 選用 (取決於您的伺服器)
- 預設基礎 URL: `http://127.0.0.1:8000/v1`

若要在本機啟用自動探索 (如果您的伺服器不強制執行憑證，任何值都有效):

```bash
export VLLM_API_KEY="vllm-local"
```

然後設定一個模型 (替換為 `/v1/models` 返回的其中一個 ID):

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

有關詳細資訊，請參閱 [/providers/vllm](/providers/vllm)。

### 本機代理 (LM Studio, vLLM, LiteLLM 等)

範例 (相容 OpenAI):

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

注意事項:

- 對於自訂供應商，`reasoning`、`input`、`cost`、`contextWindow` 和 `maxTokens` 是選用的。
  當省略時，OpenClaw 預設為:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 建議: 設定符合您的代理/模型限制的明確值。

## CLI 範例

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

另請參閱: [/gateway/configuration](/gateway/configuration) 以獲取完整的設定範例。
