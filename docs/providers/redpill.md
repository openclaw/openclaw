---
summary: "Use Redpill AI GPU TEE models in Clawdbot"
read_when:
  - You want privacy-focused inference with hardware-verified security
  - You want GPU TEE model setup guidance
  - You want to deploy Clawdbot on Phala Cloud for full TEE privacy
---

# Redpill AI

Redpill AI provides access to AI models running in GPU-based Trusted Execution Environments (TEEs) with cryptographic attestation. All models run inside secure hardware enclaves, ensuring memory encryption, tamper-proof execution, and verifiable computation.

## Why Redpill in Clawdbot

- **Hardware-verified privacy** via GPU TEE technology with cryptographic attestation
- **Zero trust architecture** with memory encryption and isolated execution
- **18 verified models** across 4 TEE providers (Phala, Tinfoil, Chutes, Near-AI)
- **Verifiable computation** ensuring your prompts and responses stay private
- OpenAI-compatible `/v1` endpoints

## Privacy Tiers

Redpill offers two privacy levels:

| Tier         | Description                                                                                                                                | Models                                           | Status         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------- |
| **GPU TEE**  | Hardware-verified privacy with cryptographic attestation. Models run in secure enclaves with memory encryption and tamper-proof execution. | 18 models across Phala, Tinfoil, Chutes, Near-AI | ✅ Available   |
| **Extended** | Additional models with standard privacy (no TEE hardware guarantee).                                                                       | TBD                                              | 🔜 Coming soon |

## Features

- **GPU TEE security**: All models run in hardware-secured enclaves with cryptographic attestation
- **Memory encryption**: Data stays encrypted in GPU memory during inference
- **Tamper-proof execution**: Verifiable computation guarantees no unauthorized access
- **4 TEE providers**: Phala Network (10 models), Tinfoil (4), Chutes (1), Near-AI (3)
- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration
- **Streaming**: ✅ Supported on all models
- **Function calling**: ✅ Supported on select models
- **Vision**: ✅ Supported on Qwen3 VL 30B model
- **No hard rate limits**: Fair-use throttling may apply for extreme usage

## Setup

### 1. Get API Key

1. Sign up at [redpill.ai](https://redpill.ai)
2. Navigate to **API Keys** in your dashboard
3. Create a new API key
4. Copy your API key (format: `rp_xxxxxxxxxxxx`)

### 2. Configure Clawdbot

**Option A: Environment Variable**

```bash
export REDPILL_API_KEY="rp_xxxxxxxxxxxx"
```

**Option B: Interactive Setup (Recommended)**

```bash
clawdbot onboard --auth-choice redpill-api-key
```

This will:

1. Prompt for your API key (or use existing `REDPILL_API_KEY`)
2. Show all available GPU TEE models
3. Let you pick your default model
4. Configure the provider automatically

**Option C: Non-interactive**

```bash
clawdbot onboard --non-interactive \
  --auth-choice redpill-api-key \
  --token "rp_xxxxxxxxxxxx"
```

### 3. Verify Setup

```bash
clawdbot agent --message "Hello, are you working?"
```

## Model Selection

After setup, Clawdbot shows all available Redpill models. Pick based on your needs:

- **Default (our pick)**: `redpill/deepseek/deepseek-v3.2` for strong reasoning with GPU TEE privacy.
- **Best reasoning**: `redpill/deepseek/deepseek-r1-0528` or `redpill/moonshotai/kimi-k2-thinking` for complex reasoning tasks.
- **Best coding**: `redpill/qwen/qwen3-coder-480b-a35b-instruct` for code generation and analysis.
- **Vision tasks**: `redpill/qwen/qwen3-vl-30b-a3b-instruct` for image understanding.
- **Fast + capable**: `redpill/meta-llama/llama-3.3-70b-instruct` for balanced performance.

Change your default model anytime using the `/model` directive in chat:

```
/model redpill/deepseek/deepseek-r1-0528
```

List all available models:

```bash
clawdbot models list | grep redpill
```

## GPU TEE Models (19 Total)

All models run in hardware-secured GPU TEE environments with cryptographic attestation.

### Phala Network (10 models)

| Model ID                                 | Name                 | Context | $/M In | $/M Out | Features               |
| ---------------------------------------- | -------------------- | ------- | ------ | ------- | ---------------------- |
| `z-ai/glm-4.7-flash`                     | GLM 4.7 Flash        | 203k    | $0.10  | $0.43   | General, multilingual  |
| `qwen/qwen3-embedding-8b`                | Qwen3 Embedding 8B   | 33k     | $0.01  | $0.00   | Embeddings             |
| `phala/uncensored-24b`                   | Uncensored 24B       | 33k     | $0.20  | $0.90   | Uncensored             |
| `deepseek/deepseek-v3.2`                 | DeepSeek v3.2        | 164k    | $0.27  | $0.40   | **Default**, reasoning |
| `qwen/qwen3-vl-30b-a3b-instruct`         | Qwen3 VL 30B         | 128k    | $0.20  | $0.70   | Vision                 |
| `sentence-transformers/all-minilm-l6-v2` | All-MiniLM-L6-v2     | 512     | $0.005 | $0.00   | Embeddings             |
| `qwen/qwen-2.5-7b-instruct`              | Qwen 2.5 7B Instruct | 33k     | $0.04  | $0.10   | General                |
| `google/gemma-3-27b-it`                  | Gemma 3 27B IT       | 54k     | $0.11  | $0.40   | General                |
| `openai/gpt-oss-120b`                    | GPT OSS 120B         | 131k    | $0.10  | $0.49   | General                |
| `openai/gpt-oss-20b`                     | GPT OSS 20B          | 131k    | $0.04  | $0.15   | General                |

### Tinfoil (4 models)

| Model ID                              | Name                   | Context | $/M In | $/M Out | Features  |
| ------------------------------------- | ---------------------- | ------- | ------ | ------- | --------- |
| `moonshotai/kimi-k2-thinking`         | Kimi K2 Thinking       | 262k    | $2.00  | $2.00   | Reasoning |
| `deepseek/deepseek-r1-0528`           | DeepSeek R1            | 164k    | $2.00  | $2.00   | Reasoning |
| `qwen/qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B       | 262k    | $2.00  | $2.00   | Code      |
| `meta-llama/llama-3.3-70b-instruct`   | Llama 3.3 70B Instruct | 131k    | $2.00  | $2.00   | General   |

### Chutes (2 models)

| Model ID               | Name         | Context | $/M In | $/M Out | Features           |
| ---------------------- | ------------ | ------- | ------ | ------- | ------------------ |
| `moonshotai/kimi-k2.5` | Kimi K2.5    | 262k    | $0.60  | $3.00   | Vision, multimodal |
| `minimax/minimax-m2.1` | MiniMax M2.1 | 197k    | $0.30  | $1.20   | General            |

### Near-AI (3 models)

| Model ID                           | Name               | Context | $/M In | $/M Out | Features              |
| ---------------------------------- | ------------------ | ------- | ------ | ------- | --------------------- |
| `deepseek/deepseek-chat-v3.1`      | DeepSeek Chat v3.1 | 164k    | $1.00  | $2.50   | General               |
| `qwen/qwen3-30b-a3b-instruct-2507` | Qwen3 30B Instruct | 262k    | $0.15  | $0.45   | General               |
| `z-ai/glm-4.7`                     | GLM 4.7            | 131k    | $0.85  | $3.30   | General, multilingual |

## Which Model Should I Use?

| Use Case                   | Recommended Model                     | Why                                      |
| -------------------------- | ------------------------------------- | ---------------------------------------- |
| **General chat**           | `deepseek/deepseek-v3.2`              | Default, strong reasoning, GPU TEE       |
| **Complex reasoning**      | `deepseek/deepseek-r1-0528`           | Reasoning-optimized with R1 architecture |
| **Long context reasoning** | `moonshotai/kimi-k2-thinking`         | 262k context, reasoning-focused          |
| **Coding**                 | `qwen/qwen3-coder-480b-a35b-instruct` | Code-specialized, 262k context           |
| **Vision + multimodal**    | `moonshotai/kimi-k2.5`                | Visual coding, agentic, 262k context     |
| **Vision tasks**           | `qwen/qwen3-vl-30b-a3b-instruct`      | Vision model, 128k context               |
| **Fast + balanced**        | `meta-llama/llama-3.3-70b-instruct`   | Llama 3.3, good all-around               |
| **Uncensored**             | `phala/uncensored-24b`                | No content restrictions                  |
| **Embeddings**             | `qwen/qwen3-embedding-8b`             | Text embeddings                          |

## Pricing

Redpill uses a credit-based system. Check [redpill.ai/pricing](https://redpill.ai/pricing) for current rates.

All GPU TEE models incur costs based on:

- Input tokens (per 1M tokens)
- Output tokens (per 1M tokens)
- TEE attestation overhead (minimal)

## Usage Examples

```bash
# Use default model (configured in agents.defaults.model.primary)
clawdbot agent --message "Your question here"

# Configure a specific default model
clawdbot config set agents.defaults.model.primary redpill/deepseek/deepseek-r1-0528

# Use with local session
clawdbot agent --local --session-id my-session --message "Your question here"

# Switch model mid-chat using /model directive
> /model redpill/moonshotai/kimi-k2-thinking
```

## Streaming & Tool Support

| Feature              | Support                                     |
| -------------------- | ------------------------------------------- |
| **Streaming**        | ✅ All models                               |
| **Function calling** | ✅ Select models (check model capabilities) |
| **Vision/Images**    | ✅ Qwen3 VL 30B only                        |
| **JSON mode**        | ✅ Supported via `response_format`          |

## Troubleshooting

### API key not recognized

```bash
echo $REDPILL_API_KEY
clawdbot models list | grep redpill
```

Ensure the key starts with `rp_`.

### Model not available

Run `clawdbot models list | grep redpill` to see currently available models. All 18 GPU TEE models should be listed.

### Connection issues

Redpill API is at `https://api.redpill.ai/v1`. Ensure your network allows HTTPS connections.

### TEE attestation failed

If you receive attestation errors:

1. Try a different TEE provider model
2. Verify your API key is valid
3. Check the main Redpill website for service announcements

## Config File Example

```json5
{
  env: { REDPILL_API_KEY: "rp_..." },
  agents: { defaults: { model: { primary: "redpill/deepseek/deepseek-v3.2" } } },
  models: {
    mode: "merge",
    providers: {
      redpill: {
        baseUrl: "https://api.redpill.ai/v1",
        apiKey: "${REDPILL_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "deepseek/deepseek-v3.2",
            name: "DeepSeek v3.2 (GPU TEE)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 164000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## More Information

- [Redpill AI](https://redpill.ai)
- [API Documentation](https://docs.redpill.ai)
- [GPU TEE Technology](https://docs.redpill.ai/privacy/overview)
- [Pricing](https://redpill.ai/pricing)
- [Phala Cloud](https://cloud.phala.network)
- [Phala Cloud CLI Docs](https://docs.phala.network/phala-cloud/references/phala-cloud-cli/phala/overview)
