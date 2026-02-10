---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Model provider overview with example configs + CLI flows"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a provider-by-provider model setup reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want example configs or CLI onboarding commands for model providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Model Providers"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Model providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This page covers **LLM/model providers** (not chat channels like WhatsApp/Telegram).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For model selection rules, see [/concepts/models](/concepts/models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model refs use `provider/model` (example: `opencode/claude-opus-4-6`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you set `agents.defaults.models`, it becomes the allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI helpers: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Built-in providers (pi-ai catalog)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw ships with the pi‑ai catalog. These providers require **no**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`models.providers` config; just set auth + pick a model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenAI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `openai`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `OPENAI_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `openai/gpt-5.1-codex`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw onboard --auth-choice openai-api-key`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Anthropic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `anthropic`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `ANTHROPIC_API_KEY` or `claude setup-token`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `anthropic/claude-opus-4-6`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw onboard --auth-choice token` (paste setup-token) or `openclaw models auth paste-token --provider anthropic`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenAI Code (Codex)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `openai-codex`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: OAuth (ChatGPT)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `openai-codex/gpt-5.3-codex`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw onboard --auth-choice openai-codex` or `openclaw models auth login --provider openai-codex`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenCode Zen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `opencode`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `opencode/claude-opus-4-6`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw onboard --auth-choice opencode-zen`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Google Gemini (API key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `google`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `GEMINI_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `google/gemini-3-pro-preview`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw onboard --auth-choice gemini-api-key`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Google Vertex, Antigravity, and Gemini CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: `google-vertex`, `google-antigravity`, `google-gemini-cli`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: Vertex uses gcloud ADC; Antigravity/Gemini CLI use their respective auth flows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Antigravity OAuth is shipped as a bundled plugin (`google-antigravity-auth`, disabled by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Enable: `openclaw plugins enable google-antigravity-auth`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Login: `openclaw models auth login --provider google-antigravity --set-default`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gemini CLI OAuth is shipped as a bundled plugin (`google-gemini-cli-auth`, disabled by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Enable: `openclaw plugins enable google-gemini-cli-auth`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Login: `openclaw models auth login --provider google-gemini-cli --set-default`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Note: you do **not** paste a client id or secret into `openclaw.json`. The CLI login flow stores（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tokens in auth profiles on the gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Z.AI (GLM)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `zai`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `ZAI_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `zai/glm-4.7`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw onboard --auth-choice zai-api-key`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Aliases: `z.ai/*` and `z-ai/*` normalize to `zai/*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Vercel AI Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `vercel-ai-gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `AI_GATEWAY_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `vercel-ai-gateway/anthropic/claude-opus-4.6`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Other built-in providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `openrouter/anthropic/claude-sonnet-4-5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- xAI: `xai` (`XAI_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Groq: `groq` (`GROQ_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - GLM models on Cerebras use ids `zai-glm-4.7` and `zai-glm-4.6`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - OpenAI-compatible base URL: `https://api.cerebras.ai/v1`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mistral: `mistral` (`MISTRAL_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Providers via `models.providers` (custom/base URL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `models.providers` (or `models.json`) to add **custom** providers or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenAI/Anthropic‑compatible proxies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Moonshot AI (Kimi)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Moonshot uses OpenAI-compatible endpoints, so configure it as a custom provider:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `moonshot`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `MOONSHOT_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `moonshot/kimi-k2.5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Kimi K2 model IDs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{/_moonshot-kimi-k2-model-refs:start_/ && null}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `moonshot/kimi-k2.5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `moonshot/kimi-k2-0905-preview`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `moonshot/kimi-k2-turbo-preview`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `moonshot/kimi-k2-thinking`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `moonshot/kimi-k2-thinking-turbo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {/_moonshot-kimi-k2-model-refs:end_/ && null}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: { model: { primary: "moonshot/kimi-k2.5" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      moonshot: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.moonshot.ai/v1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${MOONSHOT_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "openai-completions",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Kimi Coding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Kimi Coding uses Moonshot AI's Anthropic-compatible endpoint:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `kimi-coding`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `KIMI_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `kimi-coding/k2p5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { KIMI_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: { model: { primary: "kimi-coding/k2p5" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Qwen OAuth (free tier)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Qwen provides OAuth access to Qwen Coder + Vision via a device-code flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable the bundled plugin, then log in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins enable qwen-portal-auth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth login --provider qwen-portal --set-default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model refs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `qwen-portal/coder-model`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `qwen-portal/vision-model`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/providers/qwen](/providers/qwen) for setup details and notes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Synthetic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Synthetic provides Anthropic-compatible models behind the `synthetic` provider:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `synthetic`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `SYNTHETIC_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw onboard --auth-choice synthetic-api-key`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      synthetic: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.synthetic.new/anthropic",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${SYNTHETIC_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "anthropic-messages",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.1", name: "MiniMax M2.1" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### MiniMax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MiniMax is configured via `models.providers` because it uses custom endpoints:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MiniMax (Anthropic‑compatible): `--auth-choice minimax-api`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `MINIMAX_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/providers/minimax](/providers/minimax) for setup details, model options, and config snippets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Ollama（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ollama is a local LLM runtime that provides an OpenAI-compatible API:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `ollama`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: None required (local server)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model: `ollama/llama3.3`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installation: [https://ollama.ai](https://ollama.ai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install Ollama, then pull a model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ollama pull llama3.3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: { model: { primary: "ollama/llama3.3" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ollama is automatically detected when running locally at `http://127.0.0.1:11434/v1`. See [/providers/ollama](/providers/ollama) for model recommendations and custom configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Local proxies (LM Studio, vLLM, LiteLLM, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (OpenAI‑compatible):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "lmstudio/minimax-m2.1-gs32" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      lmstudio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "http://localhost:1234/v1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "LMSTUDIO_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "openai-completions",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "minimax-m2.1-gs32",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "MiniMax M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 200000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For custom providers, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens` are optional.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  When omitted, OpenClaw defaults to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `reasoning: false`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `input: ["text"]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `contextWindow: 200000`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `maxTokens: 8192`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Recommended: set explicit values that match your proxy/model limits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice opencode-zen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models set opencode/claude-opus-4-6（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See also: [/gateway/configuration](/gateway/configuration) for full configuration examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
