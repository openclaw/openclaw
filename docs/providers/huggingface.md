---
summary: "Hugging Face Inference setup (auth + model selection)"
read_when:
  - You want to use Hugging Face Inference with OpenClaw
  - You need the HF token env var or CLI auth choice
title: "Hugging Face (Inference)"
---

# Hugging Face (Inference)

[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers) offer OpenAI-compatible chat completions through a single router API. You get access to many models (DeepSeek, Llama, and more) with one token. OpenClaw uses the **OpenAI-compatible endpoint** (chat completions only); for text-to-image, embeddings, or speech use the [HF inference clients](https://huggingface.co/docs/api-inference/quicktour) directly.

- Provider: `huggingface`
- Auth: `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN` (fine-grained token with **Make calls to Inference Providers**)
- API: OpenAI-compatible (`https://router.huggingface.co/v1`)
- Billing: Single HF token; [pricing](https://huggingface.co/docs/inference-providers/pricing) follows provider rates with a free tier.

## Quick start

1. Create a fine-grained token at [Hugging Face → Settings → Tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) with the **Make calls to Inference Providers** permission.
2. Run onboarding and choose **Hugging Face** in the provider dropdown, then enter your API key when prompted:

```bash
openclaw onboard --auth-choice huggingface-api-key
```

3. In the **Default Hugging Face model** dropdown, pick the model you want (the list is loaded from the Inference API when you have a valid token; otherwise a built-in list is shown). Your choice is saved as the default model.
4. You can also set or change the default model later in config:

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

This will set `huggingface/deepseek-ai/DeepSeek-R1` as the default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Model discovery and onboarding dropdown

OpenClaw discovers models by calling the **Inference endpoint directly**:

```bash
GET https://router.huggingface.co/v1/models
```

(Optional: send `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` or `$HF_TOKEN` for the full list; some endpoints return a subset without auth.) The response is OpenAI-style `{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }`.

When you configure a Hugging Face API key (via onboarding, `HUGGINGFACE_HUB_TOKEN`, or `HF_TOKEN`), OpenClaw uses this GET to discover available chat-completion models. During **interactive onboarding**, after you enter your token you see a **Default Hugging Face model** dropdown populated from that list (or the built-in catalog if the request fails). At runtime (e.g. Gateway startup), when a key is present, OpenClaw again calls **GET** `https://router.huggingface.co/v1/models` to refresh the catalog. The list is merged with a built-in catalog (for metadata like context window and cost). If the request fails or no key is set, only the built-in catalog is used.

## Model names and editable options

- **Name from API:** The model display name is **hydrated from GET /v1/models** when the API returns `name`, `title`, or `display_name`; otherwise it is derived from the model id (e.g. `deepseek-ai/DeepSeek-R1` → “DeepSeek R1”).
- **Override display name:** You can set a custom label per model in config so it appears the way you want in the CLI and UI:

```json5
{
  agents: {
    defaults: {
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1 (fast)" },
        "huggingface/deepseek-ai/DeepSeek-R1:cheapest": { alias: "DeepSeek R1 (cheap)" },
      },
    },
  },
}
```

- **Provider / policy selection:** Append a suffix to the **model id** to choose how the router picks the backend:
  - **`:fastest`** — highest throughput (router picks; provider choice is **locked** — no interactive backend picker).
  - **`:cheapest`** — lowest cost per output token (router picks; provider choice is **locked**).
  - **`:provider`** — force a specific backend (e.g. `:sambanova`, `:together`).

  When you select **:cheapest** or **:fastest** (e.g. in the onboarding model dropdown), the provider is locked: the router decides by cost or speed and no optional “prefer specific backend” step is shown. You can add these as separate entries in `models.providers.huggingface.models` or set `model.primary` with the suffix. You can also set your default order in [Inference Provider settings](https://hf.co/settings/inference-providers) (no suffix = use that order).

- **Config merge:** Existing entries in `models.providers.huggingface.models` (e.g. in `models.json`) are kept when config is merged. So any custom `name`, `alias`, or model options you set there are preserved.

## Model IDs and configuration examples

Model refs use the form `huggingface/<org>/<model>` (Hub-style IDs). The list below is from **GET** `https://router.huggingface.co/v1/models`; your catalog may include more.

**Example IDs (from the inference endpoint):**

| Model                  | Ref (prefix with `huggingface/`)    |
| ---------------------- | ----------------------------------- |
| DeepSeek R1            | `deepseek-ai/DeepSeek-R1`           |
| DeepSeek V3.2          | `deepseek-ai/DeepSeek-V3.2`         |
| Qwen3 8B               | `Qwen/Qwen3-8B`                     |
| Qwen2.5 7B Instruct    | `Qwen/Qwen2.5-7B-Instruct`          |
| Qwen3 32B              | `Qwen/Qwen3-32B`                    |
| Llama 3.3 70B Instruct | `meta-llama/Llama-3.3-70B-Instruct` |
| Llama 3.1 8B Instruct  | `meta-llama/Llama-3.1-8B-Instruct`  |
| GPT-OSS 120B           | `openai/gpt-oss-120b`               |
| GLM 4.7                | `zai-org/GLM-4.7`                   |
| Kimi K2.5              | `moonshotai/Kimi-K2.5`              |

You can append `:fastest`, `:cheapest`, or `:provider` (e.g. `:together`, `:sambanova`) to the model id. Set your default order in [Inference Provider settings](https://hf.co/settings/inference-providers); see [Inference Providers](https://huggingface.co/docs/inference-providers) and **GET** `https://router.huggingface.co/v1/models` for the full list.

### Complete configuration examples

**Primary DeepSeek R1 with Qwen fallback:**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-R1",
        fallbacks: ["huggingface/Qwen/Qwen3-8B"],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1" },
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
      },
    },
  },
}
```

**Qwen as default, with :cheapest and :fastest variants:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen3-8B" },
      models: {
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
        "huggingface/Qwen/Qwen3-8B:cheapest": { alias: "Qwen3 8B (cheapest)" },
        "huggingface/Qwen/Qwen3-8B:fastest": { alias: "Qwen3 8B (fastest)" },
      },
    },
  },
}
```

**DeepSeek + Llama + GPT-OSS with aliases:**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-V3.2",
        fallbacks: [
          "huggingface/meta-llama/Llama-3.3-70B-Instruct",
          "huggingface/openai/gpt-oss-120b",
        ],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-V3.2": { alias: "DeepSeek V3.2" },
        "huggingface/meta-llama/Llama-3.3-70B-Instruct": { alias: "Llama 3.3 70B" },
        "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
      },
    },
  },
}
```

**Force a specific backend with :provider:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1:together" },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1:together": { alias: "DeepSeek R1 (Together)" },
      },
    },
  },
}
```

**Multiple Qwen and DeepSeek models with policy suffixes:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest" },
      models: {
        "huggingface/Qwen/Qwen2.5-7B-Instruct": { alias: "Qwen2.5 7B" },
        "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest": { alias: "Qwen2.5 7B (cheap)" },
        "huggingface/deepseek-ai/DeepSeek-R1:fastest": { alias: "DeepSeek R1 (fast)" },
        "huggingface/meta-llama/Llama-3.1-8B-Instruct": { alias: "Llama 3.1 8B" },
      },
    },
  },
}
```
