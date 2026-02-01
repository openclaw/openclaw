---
summary: "Use Tinfoil confidential AI models in OpenClaw"
read_when:
  - You want confidential AI inference in OpenClaw
  - You want Tinfoil setup guidance
---
# Tinfoil

**Tinfoil** provides confidential AI inference with built-in security verification. All inference runs inside secure enclaves with automatic attestation checks and certificate pinning.

## Why Tinfoil in OpenClaw

- **Confidential compute**: Models run in secure enclaves with cryptographic verification.
- **Attestation**: Automatic verification that servers operate within genuine secure enclaves.
- **Certificate pinning**: Prevents certificate swapping and traffic redirection.
- **OpenAI-compatible**: Standard `/v1` endpoints for easy integration.

## Features

- **Secure enclaves**: All inference runs in verified confidential environments
- **Automatic verification**: SDK validates enclave attestation on every request
- **Code verification**: Confirms enclave runs expected code from GitHub/Sigstore
- **Streaming**: Supported on all models
- **Function calling**: Supported on select models
- **Vision**: Supported on models with vision capability (Qwen3-VL)

## Setup

### 1. Get API Key

1. Sign up at [dash.tinfoil.sh](https://dash.tinfoil.sh)
2. Create a new API key
3. Copy your API key

### 2. Configure OpenClaw

**Option A: Environment Variable**

```bash
export TINFOIL_API_KEY="your-api-key"
```

**Option B: Interactive Setup (Recommended)**

```bash
openclaw onboard --auth-choice tinfoil-api-key
```

This will:
1. Prompt for your API key (or use existing `TINFOIL_API_KEY`)
2. Show all available Tinfoil models
3. Let you pick your default model
4. Configure the provider automatically

**Option C: Non-interactive**

```bash
openclaw onboard --non-interactive \
  --auth-choice tinfoil-api-key \
  --tinfoil-api-key "your-api-key"
```

### 3. Verify Setup

```bash
openclaw chat --model tinfoil/llama3-3-70b "Hello, are you working?"
```

## Model Selection

After setup, pick based on your needs:

- **General chat**: `tinfoil/llama3-3-70b` for balanced performance.
- **Complex reasoning**: `tinfoil/deepseek-r1-0528` for state-of-the-art reasoning.
- **Agentic workflows**: `tinfoil/kimi-k2-thinking` for multi-step tool orchestration.
- **Coding**: `tinfoil/qwen3-coder-480b` for code-focused tasks.
- **Vision**: `tinfoil/qwen3-vl-30b` for image understanding.

Change your default model anytime:

```bash
openclaw models set tinfoil/deepseek-r1-0528
openclaw models set tinfoil/llama3-3-70b
```

List all available models:

```bash
openclaw models list | grep tinfoil
```

## Available Models

### Chat Models

| Model ID | Name | Context | Features |
|----------|------|---------|----------|
| `deepseek-r1-0528` | DeepSeek R1 | 128K | Reasoning, math, function calling |
| `kimi-k2-thinking` | Kimi K2 Thinking | 256K | Deep reasoning, tool orchestration |
| `gpt-oss-120b` | GPT-OSS 120B | 128K | Reasoning, function calling |
| `llama3-3-70b` | Llama 3.3 70B | 128K | Multilingual, dialogue |
| `qwen3-coder-480b` | Qwen3 Coder 480B | 128K | Agentic coding, large codebase analysis |

### Vision Models

| Model ID | Name | Context | Features |
|----------|------|---------|----------|
| `qwen3-vl-30b` | Qwen3-VL 30B | 256K | Image/video analysis, OCR |

## Which Model Should I Use?

| Use Case | Recommended Model | Why |
|----------|-------------------|-----|
| **General chat** | `llama3-3-70b` | Good all-around, multilingual |
| **Complex reasoning** | `deepseek-r1-0528` | State-of-the-art reasoning |
| **Agentic workflows** | `kimi-k2-thinking` | Multi-step tool orchestration |
| **Coding** | `qwen3-coder-480b` | Code-optimized |
| **Vision tasks** | `qwen3-vl-30b` | Image/video understanding |
| **Production use** | `gpt-oss-120b` | Configurable reasoning levels |

## Streaming and Tool Support

| Feature | Support |
|---------|---------|
| **Streaming** | All models |
| **Function calling** | Most models |
| **Vision/Images** | `qwen3-vl-30b` |
| **JSON mode** | Supported |

## Usage Examples

```bash
# Use general chat model
openclaw chat --model tinfoil/llama3-3-70b

# Use reasoning model
openclaw chat --model tinfoil/deepseek-r1-0528

# Use vision model with image
openclaw chat --model tinfoil/qwen3-vl-30b

# Use coding model
openclaw chat --model tinfoil/qwen3-coder-480b
```

## Troubleshooting

### API key not recognized

```bash
echo $TINFOIL_API_KEY
openclaw models list | grep tinfoil
```

### Connection issues

Tinfoil API is at `https://inference.tinfoil.sh/v1`. Ensure your network allows HTTPS connections.

## Config file example

```json5
{
  env: { TINFOIL_API_KEY: "your-api-key" },
  agents: { defaults: { model: { primary: "tinfoil/deepseek-r1-0528" } } },
  models: {
    mode: "merge",
    providers: {
      tinfoil: {
        baseUrl: "https://inference.tinfoil.sh/v1",
        apiKey: "${TINFOIL_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "deepseek-r1-0528",
            name: "DeepSeek R1",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

## Links

- [Tinfoil](https://tinfoil.sh)
- [API Documentation](https://docs.tinfoil.sh)
- [Dashboard](https://dash.tinfoil.sh)
