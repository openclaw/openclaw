---
summary: "Use ForAI as an OpenAI-compatible model gateway in OpenClaw"
title: "ForAI"
read_when:
  - You want to use ForAI with OpenClaw
  - You need an OpenAI-compatible base URL example for ForAI
---

[ForAI](https://www.forai.ai) is an OpenAI-compatible AI model gateway for developers and AI agent builders. Configure it as a custom OpenAI-compatible provider through `models.providers`.

| Property      | Value                          |
| ------------- | ------------------------------ |
| Provider id   | `forai`                        |
| Provider type | OpenAI-compatible              |
| API           | `openai-completions`           |
| Base URL      | `https://www.forai.ai/v1`      |
| API key       | Your ForAI API key             |
| Docs          | <https://www.forai.ai/docs>    |
| Sign up       | <https://www.forai.ai/sign-up> |

<Tip>
Use `https://www.forai.ai/v1` as the base URL. If the chat completions endpoint is `https://www.forai.ai/v1/chat/completions`, the base URL should include `/v1` and should not stop at `https://www.forai.ai`.
</Tip>

## Configuration

Add ForAI under `models.providers`, then select a model with the `forai/<model-id>` ref. Replace `your-model-id` with a model ID available from your ForAI account.

```json5
{
  agents: {
    defaults: {
      model: { primary: "forai/your-model-id" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      forai: {
        baseUrl: "https://www.forai.ai/v1",
        apiKey: "${FORAI_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "ForAI model",
            input: ["text"],
          },
        ],
      },
    },
  },
}
```

For OpenAI SDK-compatible tools outside OpenClaw, the equivalent environment variables are:

```bash
export OPENAI_API_KEY="your_forai_api_key"
export OPENAI_BASE_URL="https://www.forai.ai/v1"
```

## Notes

- ForAI supports OpenAI-compatible chat completions and can be used with agent workflows that support custom OpenAI-compatible providers.
- Configure image-capable ForAI models with `input: ["text", "image"]` so OpenClaw can pass images natively.
- Get an API key from [ForAI](https://www.forai.ai).

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and custom base URLs.
  </Card>
  <Card title="Tools and custom providers" href="/gateway/config-tools#custom-providers-and-base-urls" icon="gear">
    Full custom provider configuration reference.
  </Card>
</CardGroup>
