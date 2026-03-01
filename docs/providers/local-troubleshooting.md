---
summary: "Troubleshooting common issues with local LLM providers (Ollama, vLLM)"
read_when:
  - Local models are not working or detected
  - You get 'No API key found' errors for Ollama or vLLM
  - Models run but responses are broken, slow, or missing tools
title: "Local Providers Troubleshooting"
---

# Local Providers Troubleshooting

Common issues when running OpenClaw with local model providers like Ollama and vLLM.

For provider-specific setup instructions, see [Ollama](/providers/ollama) or [vLLM](/providers/vllm).

## "No API key found for provider ollama"

Local providers still need an API key value to register with OpenClaw. Any string works:

```bash
# Ollama
export OLLAMA_API_KEY="ollama-local"

# vLLM
export VLLM_API_KEY="vllm-local"
```

Or set it in your config:

```bash
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

Make sure the environment variable is set in the same shell (or service) that runs the gateway. If you use systemd, add it to the service environment.

## "Unknown model: ollama/..."

This usually means the provider was not registered (API key missing), or auto-discovery did not find the model.

Check:

1. Is the API key set? `echo $OLLAMA_API_KEY`
2. Is Ollama running? `curl http://localhost:11434/api/tags`
3. Is the model pulled? `ollama list`
4. Does the model support tools? OpenClaw only auto-discovers tool-capable models. If your model does not report tool support, define it explicitly in config (see [Ollama explicit setup](/providers/ollama#explicit-setup-manual-models)).

## No tool calling

Some local models do not support tool calling or report it inconsistently. If the model runs but tools fail:

- Check if the model reports tool support: `ollama show <model>` should list `tools` in capabilities
- Try a model known to support tools: `gpt-oss:20b`, `qwen2.5-coder:32b`, `llama3.3`
- For vLLM, ensure your model was loaded with tool support enabled

## Connection refused

```bash
# Check Ollama
curl http://localhost:11434/api/tags

# Check vLLM
curl http://localhost:8000/v1/models
```

If these fail:

- Ollama: run `ollama serve` or check if the Ollama app is running
- vLLM: verify the server is started and listening on the expected port
- Docker users: make sure the host port is mapped (e.g., `-p 11434:11434`)

## Slow responses or timeouts

Local models are limited by your hardware. Common causes:

- Model too large for available RAM/VRAM (check with `ollama ps`)
- Context window set too high (reduce `contextWindow` in explicit config)
- Multiple models loaded simultaneously (Ollama loads models on demand; unload unused ones)

## Session corruption after model errors

If a local model returns malformed responses (e.g., `stopReason: "toolUse"` without an actual tool call), the session can enter a broken state. Symptoms:

- Every subsequent message fails with tool pairing errors
- Gateway restart does not fix it

Fix: start a fresh session with `/new` or `/reset`. If the issue persists, check the session JSONL file for orphaned `toolResult` entries.

## Mixed local and cloud setup

You can use a local model as primary with cloud fallbacks:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["anthropic/claude-sonnet-4-5"],
      },
    },
  },
}
```

This gives you local-first with cloud backup when the local model fails or does not support a feature.

## See Also

- [Ollama](/providers/ollama)
- [vLLM](/providers/vllm)
- [Model Providers](/providers)
- [Gateway Troubleshooting](/gateway/troubleshooting)
