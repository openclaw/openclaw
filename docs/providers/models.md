---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Model providers (LLMs) supported by OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to choose a model provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want quick setup examples for LLM auth + model selection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Model Provider Quickstart"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Model Providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can use many LLM providers. Pick one, authenticate, then set the default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
model as `provider/model`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Highlight: Venice (Venice AI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Venice is our recommended Venice AI setup for privacy-first inference with an option to use Opus for the hardest tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `venice/llama-3.3-70b`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Best overall: `venice/claude-opus-45` (Opus remains the strongest)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Venice AI](/providers/venice).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start (two steps)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
## Supported providers (starter set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenAI (API + Codex)](/providers/openai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenRouter](/providers/openrouter)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Vercel AI Gateway](/providers/vercel-ai-gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Synthetic](/providers/synthetic)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenCode Zen](/providers/opencode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Z.AI](/providers/zai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [GLM models](/providers/glm)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [MiniMax](/providers/minimax)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Venice (Venice AI)](/providers/venice)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Amazon Bedrock](/providers/bedrock)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Qianfan](/providers/qianfan)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see [Model providers](/concepts/model-providers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
