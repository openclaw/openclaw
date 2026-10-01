# LiteLLM

Connect OpenClaw to an existing LiteLLM proxy for model routing through a shared
endpoint. The plugin supports chat models and image generation when the proxy
exposes the corresponding OpenAI-compatible routes.

## Get started

Start or obtain access to a LiteLLM proxy, then run:

```bash
openclaw onboard --auth-choice litellm-api-key
```

Configure `models.providers.litellm.baseUrl` for your proxy and supply its key
through onboarding or `LITELLM_API_KEY`. Refresh the proxy's catalog with
`openclaw models list --provider litellm --refresh`.

The proxy owns upstream credentials and model availability. Installing this
plugin does not start a proxy.

See the [LiteLLM guide](https://docs.openclaw.ai/providers/litellm) for endpoint,
image generation, and routing setup.
