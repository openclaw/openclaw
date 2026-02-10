---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use Venice AI privacy-focused models in OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want privacy-focused inference in OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want Venice AI setup guidance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Venice AI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Venice AI (Venice highlight)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Venice** is our highlight Venice setup for privacy-first inference with optional anonymized access to proprietary models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Venice AI provides privacy-focused AI inference with support for uncensored models and access to major proprietary models through their anonymized proxy. All inference is private by default—no training on your data, no logging.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why Venice in OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Private inference** for open-source models (no logging).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Uncensored models** when you need them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Anonymized access** to proprietary models (Opus/GPT/Gemini) when quality matters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenAI-compatible `/v1` endpoints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Privacy Modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Venice offers two privacy levels — understanding this is key to choosing your model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Mode           | Description                                                                                                          | Models                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Private**    | Fully private. Prompts/responses are **never stored or logged**. Ephemeral.                                          | Llama, Qwen, DeepSeek, Venice Uncensored, etc. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Anonymized** | Proxied through Venice with metadata stripped. The underlying provider (OpenAI, Anthropic) sees anonymized requests. | Claude, GPT, Gemini, Grok, Kimi, MiniMax       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Privacy-focused**: Choose between "private" (fully private) and "anonymized" (proxied) modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Uncensored models**: Access to models without content restrictions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Major model access**: Use Claude, GPT-5.2, Gemini, Grok via Venice's anonymized proxy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Streaming**: ✅ Supported on all models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Function calling**: ✅ Supported on select models (check model capabilities)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Vision**: ✅ Supported on models with vision capability（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No hard rate limits**: Fair-use throttling may apply for extreme usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1. Get API Key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Sign up at [venice.ai](https://venice.ai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Go to **Settings → API Keys → Create new key**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Copy your API key (format: `vapi_xxxxxxxxxxxx`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2. Configure OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option A: Environment Variable**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option B: Interactive Setup (Recommended)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice venice-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This will:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Prompt for your API key (or use existing `VENICE_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Show all available Venice models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Let you pick your default model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Configure the provider automatically（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option C: Non-interactive**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --auth-choice venice-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --venice-api-key "vapi_xxxxxxxxxxxx"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3. Verify Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model Selection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After setup, OpenClaw shows all available Venice models. Pick based on your needs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Default (our pick)**: `venice/llama-3.3-70b` for private, balanced performance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Best overall quality**: `venice/claude-opus-45` for hard jobs (Opus remains the strongest).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Privacy**: Choose "private" models for fully private inference.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Capability**: Choose "anonymized" models to access Claude, GPT, Gemini via Venice's proxy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Change your default model anytime:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models set venice/claude-opus-45（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models set venice/llama-3.3-70b（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List all available models:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models list | grep venice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configure via `openclaw configure`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Run `openclaw configure`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Select **Model/auth**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Choose **Venice AI**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Which Model Should I Use?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Use Case                     | Recommended Model                | Why                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------------- | -------------------------------- | ----------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **General chat**             | `llama-3.3-70b`                  | Good all-around, fully private            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Best overall quality**     | `claude-opus-45`                 | Opus remains the strongest for hard tasks |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Privacy + Claude quality** | `claude-opus-45`                 | Best reasoning via anonymized proxy       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Coding**                   | `qwen3-coder-480b-a35b-instruct` | Code-optimized, 262k context              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Vision tasks**             | `qwen3-vl-235b-a22b`             | Best private vision model                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Uncensored**               | `venice-uncensored`              | No content restrictions                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Fast + cheap**             | `qwen3-4b`                       | Lightweight, still capable                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Complex reasoning**        | `deepseek-v3.2`                  | Strong reasoning, private                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Available Models (25 Total)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Private Models (15) — Fully Private, No Logging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Model ID                         | Name                    | Context (tokens) | Features                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------------------- | ----------------------- | ---------------- | ----------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k             | General                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k             | Fast, lightweight       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k             | Complex tasks           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k             | Reasoning               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k             | General                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k             | Code                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k             | General                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k             | Vision                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k              | Fast, reasoning         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k             | Reasoning               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `venice-uncensored`              | Venice Uncensored       | 32k              | Uncensored              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k             | Vision                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k             | Vision                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k             | General                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k             | Reasoning, multilingual |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Anonymized Models (10) — Via Venice Proxy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Model ID                 | Original          | Context (tokens) | Features          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------ | ----------------- | ---------------- | ----------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `claude-opus-45`         | Claude Opus 4.5   | 202k             | Reasoning, vision |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k             | Reasoning, vision |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `openai-gpt-52`          | GPT-5.2           | 262k             | Reasoning         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k             | Reasoning, vision |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `gemini-3-pro-preview`   | Gemini 3 Pro      | 202k             | Reasoning, vision |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `gemini-3-flash-preview` | Gemini 3 Flash    | 262k             | Reasoning, vision |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `grok-41-fast`           | Grok 4.1 Fast     | 262k             | Reasoning, vision |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `grok-code-fast-1`       | Grok Code Fast 1  | 262k             | Reasoning, code   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `kimi-k2-thinking`       | Kimi K2 Thinking  | 262k             | Reasoning         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `minimax-m21`            | MiniMax M2.1      | 202k             | Reasoning         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model Discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw automatically discovers models from the Venice API when `VENICE_API_KEY` is set. If the API is unreachable, it falls back to a static catalog.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `/models` endpoint is public (no auth needed for listing), but inference requires a valid API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Streaming & Tool Support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Feature              | Support                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------- | ------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Streaming**        | ✅ All models                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Function calling** | ✅ Most models (check `supportsFunctionCalling` in API) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Vision/Images**    | ✅ Models marked with "Vision" feature                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **JSON mode**        | ✅ Supported via `response_format`                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pricing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Venice uses a credit-based system. Check [venice.ai/pricing](https://venice.ai/pricing) for current rates:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Private models**: Generally lower cost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Anonymized models**: Similar to direct API pricing + small Venice fee（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Comparison: Venice vs Direct API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Aspect       | Venice (Anonymized)           | Direct API          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | ----------------------------- | ------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Privacy**  | Metadata stripped, anonymized | Your account linked |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Latency**  | +10-50ms (proxy)              | Direct              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Features** | Most features supported       | Full features       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Billing**  | Venice credits                | Provider billing    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Usage Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use default private model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw chat --model venice/llama-3.3-70b（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use Claude via Venice (anonymized)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw chat --model venice/claude-opus-45（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use uncensored model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw chat --model venice/venice-uncensored（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use vision model with image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw chat --model venice/qwen3-vl-235b-a22b（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use coding model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### API key not recognized（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo $VENICE_API_KEY（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models list | grep venice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ensure the key starts with `vapi_`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Model not available（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Venice model catalog updates dynamically. Run `openclaw models list` to see currently available models. Some models may be temporarily offline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Connection issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Venice API is at `https://api.venice.ai/api/v1`. Ensure your network allows HTTPS connections.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config file example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { VENICE_API_KEY: "vapi_..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      venice: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.venice.ai/api/v1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${VENICE_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "openai-completions",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "llama-3.3-70b",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "Llama 3.3 70B",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 131072,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Links（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Venice AI](https://venice.ai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [API Documentation](https://docs.venice.ai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Pricing](https://venice.ai/pricing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Status](https://status.venice.ai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
