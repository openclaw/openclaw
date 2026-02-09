---
summary: "模型提供者總覽，包含範例設定與 CLI 流程"
read_when:
  - 你需要逐一提供者的模型設定參考
  - 你想要模型提供者的範例設定或 CLI 入門指令
title: "模型提供者"
---

# 模型提供者

27. 本頁涵蓋 **LLM/模型供應商**（不包含 WhatsApp/Telegram 等聊天通道）。
28. 有關模型選擇規則，請參閱 [/concepts/models](/concepts/models)。

## 快速規則

- 模型參照使用 `provider/model`（範例：`opencode/claude-opus-4-6`）。
- 若你設定 `agents.defaults.models`，它會成為允許清單。
- CLI 輔助工具：`openclaw onboard`、`openclaw models list`、`openclaw models set <provider/model>`。

## 內建提供者（pi‑ai catalog）

29. OpenClaw 隨附 pi‑ai 目錄。 30. 這些供應商**不需要**
    `models.providers` 設定；只要設定驗證並選擇模型即可。

### OpenAI

- 提供者：`openai`
- 驗證：`OPENAI_API_KEY`
- 範例模型：`openai/gpt-5.1-codex`
- CLI：`openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- 提供者：`anthropic`
- 驗證：`ANTHROPIC_API_KEY` 或 `claude setup-token`
- 範例模型：`anthropic/claude-opus-4-6`
- CLI：`openclaw onboard --auth-choice token`（貼上 setup-token）或 `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code（Codex）

- 提供者：`openai-codex`
- 驗證：OAuth（ChatGPT）
- 範例模型：`openai-codex/gpt-5.3-codex`
- CLI：`openclaw onboard --auth-choice openai-codex` 或 `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- 提供者：`opencode`
- 驗證：`OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`）
- 範例模型：`opencode/claude-opus-4-6`
- CLI：`openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini（API 金鑰）

- 提供者：`google`
- 驗證：`GEMINI_API_KEY`
- 範例模型：`google/gemini-3-pro-preview`
- CLI：`openclaw onboard --auth-choice gemini-api-key`

### Google Vertex、Antigravity 與 Gemini CLI

- 提供者：`google-vertex`、`google-antigravity`、`google-gemini-cli`
- 驗證：Vertex 使用 gcloud ADC；Antigravity / Gemini CLI 使用各自的驗證流程
- Antigravity OAuth 以隨附外掛形式提供（`google-antigravity-auth`，預設停用）。
  - 啟用：`openclaw plugins enable google-antigravity-auth`
  - 登入：`openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth 以隨附外掛形式提供（`google-gemini-cli-auth`，預設停用）。
  - 啟用：`openclaw plugins enable google-gemini-cli-auth`
  - 登入：`openclaw models auth login --provider google-gemini-cli --set-default`
  - 注意：你**不需要**將 client id 或 secret 貼到 `openclaw.json`。CLI 登入流程會將
    權杖儲存在閘道器主機上的驗證設定檔中。 31. CLI 登入流程會將
    權杖儲存在閘道主機上的驗證設定檔中。

### Z.AI（GLM）

- 提供者：`zai`
- 驗證：`ZAI_API_KEY`
- 範例模型：`zai/glm-4.7`
- CLI：`openclaw onboard --auth-choice zai-api-key`
  - 別名：`z.ai/*` 與 `z-ai/*` 會正規化為 `zai/*`

### Vercel AI Gateway

- 提供者：`vercel-ai-gateway`
- 驗證：`AI_GATEWAY_API_KEY`
- 範例模型：`vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI：`openclaw onboard --auth-choice ai-gateway-api-key`

### 其他內建提供者

- OpenRouter：`openrouter`（`OPENROUTER_API_KEY`）
- 範例模型：`openrouter/anthropic/claude-sonnet-4-5`
- xAI：`xai`（`XAI_API_KEY`）
- Groq：`groq`（`GROQ_API_KEY`）
- Cerebras：`cerebras`（`CEREBRAS_API_KEY`）
  - Cerebras 上的 GLM 模型使用 id `zai-glm-4.7` 與 `zai-glm-4.6`。
  - OpenAI 相容的 base URL：`https://api.cerebras.ai/v1`。
- Mistral：`mistral`（`MISTRAL_API_KEY`）
- GitHub Copilot：`github-copilot`（`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`）

## 透過 `models.providers` 的提供者（自訂 / base URL）

使用 `models.providers`（或 `models.json`）來新增**自訂**提供者或
OpenAI / Anthropic 相容的代理。

### Moonshot AI（Kimi）

Moonshot 使用 OpenAI 相容端點，因此請將其設定為自訂提供者：

- 提供者：`moonshot`
- 驗證：`MOONSHOT_API_KEY`
- 範例模型：`moonshot/kimi-k2.5`

Kimi K2 模型 id：

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

Kimi Coding 使用 Moonshot AI 的 Anthropic 相容端點：

- 提供者：`kimi-coding`
- 驗證：`KIMI_API_KEY`
- 範例模型：`kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth（免費層）

Qwen 透過裝置碼流程提供 Qwen Coder + Vision 的 OAuth 存取。
啟用隨附外掛，然後登入：
32. 啟用隨附的外掛，然後登入：

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

模型參照：

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

設定細節與注意事項請參閱 [/providers/qwen](/providers/qwen)。

### Synthetic

Synthetic 透過 `synthetic` 提供者提供 Anthropic 相容模型：

- 提供者：`synthetic`
- 驗證：`SYNTHETIC_API_KEY`
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

MiniMax 因為使用自訂端點而透過 `models.providers` 進行設定：

- MiniMax（Anthropic 相容）：`--auth-choice minimax-api`
- 驗證：`MINIMAX_API_KEY`

設定細節、模型選項與設定片段請參閱 [/providers/minimax](/providers/minimax)。

### Ollama

Ollama 是提供 OpenAI 相容 API 的本地 LLM 執行環境：

- 提供者：`ollama`
- 驗證：不需要（本地伺服器）
- 範例模型：`ollama/llama3.3`
- 安裝：<https://ollama.ai>

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

33. 在本機以 `http://127.0.0.1:11434/v1` 執行時，會自動偵測到 Ollama。 34. 請參閱 [/providers/ollama](/providers/ollama) 以取得模型建議與自訂設定。

### 本地代理（LM Studio、vLLM、LiteLLM 等）

範例（OpenAI 相容）：

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

- 對於自訂提供者，`reasoning`、`input`、`cost`、`contextWindow` 與 `maxTokens` 為選填。
  若省略，OpenClaw 會預設為：
  35. 若省略，OpenClaw 預設為：
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 建議：設定與你的代理 / 模型限制相符的明確數值。

## CLI 範例

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

另請參閱：[/gateway/configuration](/gateway/configuration) 以取得完整的設定範例。
