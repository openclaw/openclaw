# Custom Inference Server API

OpenClaw supports custom inference servers that use OpenAI-compatible chat completion endpoints with `Basic` authentication.

## Supported Providers

### OWL (Custom Model)

The `owl` provider is pre-configured to work with custom inference servers hosting the `custom_model2-37b-instruct` model.

#### Configuration via Environment Variables

You can enable the `owl` provider by setting the following environment variable:

- `OWL_API_KEY`

Example:

```bash
export OWL_API_KEY="your_custom_token"
```

#### Pre-configured Endpoint

- **Base URL**: `https://inference-web-api.mycloud.com/custom_modelo-owl-ultra-think/v1`
- **Model ID**: `custom_model2-37b-instruct`

## Generic Custom Inference Server

To support other custom inference servers with `Basic` authentication, you can add a custom provider to your `models.json` or `config.yaml`.

### Manual Configuration

Set `auth: "basic"` in your provider configuration to use `Basic` authentication instead of the default `Bearer` token.

Example `models.json`:

```json
{
  "models": {
    "providers": {
      "my-custom-provider": {
        "baseUrl": "https://your-custom-inference-server.com/v1",
        "api": "openai-completions",
        "auth": "basic",
        "apiKey": "${CUSTOM_PROVIDER_API_KEY}",
        "models": [
          {
            "id": "my-model-name",
            "name": "My Custom Model",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 8192,
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            }
          }
        ]
      }
    }
  }
}
```

### Authentication Header

When `auth: "basic"` is used, OpenClaw will include the following header in every request to the provider's `baseUrl`:

`Authorization: Basic <your_api_key>`

## Configuration via Onboarding Command

You can also use the interactive onboarding command to configure custom inference APIs:

```bash
pnpm openclaw onboard --install-daemon
```

When prompted for an LLM provider, you can:

- Select **Owl** for pre-configured custom inference (using `Basic` authentication).
- Select **Custom Provider** and choose **Basic Auth** from the **Authentication Mode** menu to manually configure any other custom endpoint.
