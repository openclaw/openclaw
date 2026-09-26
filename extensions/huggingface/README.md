# Hugging Face

Use hosted models through Hugging Face Inference Providers. OpenClaw connects to
Hugging Face's router and discovers available models; it does not download or run
the model weights locally.

## Get started

Create a Hugging Face token with permission to call Inference Providers, then run:

```bash
openclaw onboard --auth-choice huggingface-api-key
```

The Gateway also accepts `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN`. Browse the catalog
with `openclaw models list --provider huggingface`, then choose a model your
account can access.

Model availability and supported inputs depend on the selected inference
provider. See the [Hugging Face guide](https://docs.openclaw.ai/providers/huggingface)
for token setup, routing, and model configuration.
