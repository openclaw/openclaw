---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Model providers (LLMs) supported by OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to choose a model provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a quick overview of supported LLM backends（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Model Providers"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Model Providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can use many LLM providers. Pick a provider, authenticate, then set the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
default model as `provider/model`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Looking for chat channel docs (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? See [Channels](/channels).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Highlight: Venice (Venice AI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Venice is our recommended Venice AI setup for privacy-first inference with an option to use Opus for hard tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `venice/llama-3.3-70b`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Best overall: `venice/claude-opus-45` (Opus remains the strongest)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Venice AI](/providers/venice).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Authenticate with the provider (usually via `openclaw onboard`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Set the default model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Provider docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenAI (API + Codex)](/providers/openai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Qwen (OAuth)](/providers/qwen)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenRouter](/providers/openrouter)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Vercel AI Gateway](/providers/vercel-ai-gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Together AI](/providers/together)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenCode Zen](/providers/opencode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Amazon Bedrock](/providers/bedrock)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Z.AI](/providers/zai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Xiaomi](/providers/xiaomi)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [GLM models](/providers/glm)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [MiniMax](/providers/minimax)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Venice (Venice AI, privacy-focused)](/providers/venice)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Ollama (local models)](/providers/ollama)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Qianfan](/providers/qianfan)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Transcription providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Deepgram (audio transcription)](/providers/deepgram)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Community tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Use Claude Max/Pro subscription as an OpenAI-compatible API endpoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see [Model providers](/concepts/model-providers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
