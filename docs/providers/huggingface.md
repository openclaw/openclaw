# Hugging Face Provider

Hugging Face Inference API gives access to thousands of open-source models including Llama, Qwen, Mistral, Phi, and more — all via a single API key.

## Setup

1. Create an account at [huggingface.co](https://huggingface.co)
2. Generate an access token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)

```bash
export HUGGINGFACE_API_KEY=hf_...
# Alternative env vars also accepted:
# export HF_TOKEN=hf_...
# export HF_API_KEY=hf_...
```

## Models

| Model ID | Description | Context |
|----------|-------------|---------|
| `huggingface/meta-llama/Llama-3.3-70B-Instruct` | Llama 3.3 70B | 128k |
| `huggingface/Qwen/Qwen2.5-72B-Instruct` | Qwen 2.5 72B | 128k |
| `huggingface/mistralai/Mistral-7B-Instruct-v0.3` | Mistral 7B | 32k |
| `huggingface/microsoft/Phi-3.5-mini-instruct` | Phi 3.5 Mini | 128k |

> Any model available on the [Hugging Face Hub](https://huggingface.co/models?pipeline_tag=text-generation&library=transformers) that supports the Inference API can be used.
> Use the full `organization/model-name` format.

## Pricing

Many models are free up to rate limits. See [huggingface.co/pricing](https://huggingface.co/pricing) for PRO tier details.

## Notes

- Uses the OpenAI-compatible endpoint at `https://api-inference.huggingface.co/v1`
- Free tier has rate limits; PRO tier removes most restrictions
- Not all models support tool use — prefer Llama-3, Qwen-2.5, or Mistral for agent tasks
