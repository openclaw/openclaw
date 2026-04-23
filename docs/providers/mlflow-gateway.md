---
title: "MLflow Gateway"
summary: "Route requests through MLflow AI Gateway for unified multi-provider access"
read_when:
  - You want to use MLflow AI Gateway with OpenClaw
  - You need centralized model routing, cost tracking, or secrets management
---

# MLflow Gateway

[MLflow AI Gateway](https://mlflow.org/docs/latest/genai/governance/ai-gateway/)
is a database-backed LLM proxy built into the MLflow tracking server (MLflow ≥
3.0). It provides a unified OpenAI-compatible API across dozens of providers —
OpenAI, Anthropic, Gemini, Mistral, Bedrock, Ollama, and more — with built-in
secrets management, fallback/retry, traffic splitting, and budget tracking, all
configured through the MLflow UI.

| Property | Value                                            |
| -------- | ------------------------------------------------ |
| Provider | `openai` (via `models.providers.openai.baseUrl`) |
| Auth     | Managed by the gateway                           |
| API      | OpenAI-compatible                                |

## Getting started

<Steps>
  <Step title="Install MLflow and start the server">
    ```bash
    pip install mlflow[genai]
    mlflow server --host 127.0.0.1 --port 5000
    ```
  </Step>
  <Step title="Create a gateway endpoint">
    Open the MLflow UI at [http://localhost:5000](http://localhost:5000), navigate
    to **AI Gateway → Create Endpoint**, select a provider and model, and enter
    your provider API key (stored encrypted on the server).

    See the [MLflow AI Gateway documentation](https://mlflow.org/docs/latest/genai/governance/ai-gateway/endpoints/)
    for details on endpoint configuration.

  </Step>
  <Step title="Configure OpenClaw">
    Point the OpenAI provider's base URL to the gateway and set your gateway
    endpoint name as the default model:

    ```json5
    {
      models: {
        providers: {
          openai: {
            baseUrl: "http://localhost:5000/gateway/openai/v1",
            apiKey: "<any-non-empty-value>",  // provider keys are managed by the gateway; OpenClaw requires a non-empty value here
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai/my-chat-endpoint" },
        },
      },
    }
    ```

    Replace `my-chat-endpoint` with the endpoint name you created in the MLflow UI.

    The gateway is **provider-agnostic** — the same config works whether your
    endpoint routes to OpenAI, Anthropic, Gemini, Mistral, or any other supported
    provider. For example, you can create separate endpoints for different models
    and switch between them:

    ```json5
    {
      models: {
        providers: {
          openai: {
            baseUrl: "http://localhost:5000/gateway/openai/v1",
            apiKey: "<any-non-empty-value>",
          },
        },
      },
      agents: {
        defaults: {
          // Any of these work — the gateway routes to the right provider:
          // model: { primary: "openai/gpt4o-endpoint" },       // → OpenAI
          // model: { primary: "openai/claude-endpoint" },       // → Anthropic
          // model: { primary: "openai/gemini-endpoint" },       // → Google
          model: { primary: "openai/my-chat-endpoint" },
        },
      },
    }
    ```

  </Step>
</Steps>

## Provider passthrough

MLflow AI Gateway exposes **provider-specific passthrough endpoints** in
addition to its unified API. The path you use depends on the SDK/format your
client speaks:

| Path                                  | Format                             | Used by               |
| ------------------------------------- | ---------------------------------- | --------------------- |
| `/gateway/mlflow/v1/chat/completions` | MLflow unified (OpenAI-compatible) | Any OpenAI SDK client |
| `/gateway/openai/v1/chat/completions` | OpenAI passthrough                 | OpenAI SDK (native)   |
| `/gateway/anthropic/v1/messages`      | Anthropic passthrough              | Anthropic SDK         |
| `/gateway/gemini/v1beta/models/...`   | Gemini passthrough                 | Google GenAI SDK      |

Since OpenClaw uses the OpenAI provider format, either
`/gateway/openai/v1` or `/gateway/mlflow/v1` works — use
`/gateway/openai/v1` for the OpenAI-native passthrough path shown above, or
`/gateway/mlflow/v1` for the unified MLflow format. Both accept the same
OpenAI-compatible request body.

## Why use MLflow Gateway?

- **Multi-provider routing** — switch LLM providers by reconfiguring the gateway
  endpoint in the UI, no code changes
- **Secrets management** — provider API keys stored encrypted on the server; your
  OpenClaw instance sends no provider keys
- **Fallback & retry** — automatic failover to backup models on failure
- **Budget tracking** — per-endpoint or per-user token budgets
- **Traffic splitting** — route percentages of requests to different models for
  A/B testing
- **Usage tracing** — every call logged as an MLflow trace automatically

<Tip>
You can swap the underlying LLM provider at any time by reconfiguring the
gateway endpoint in the MLflow UI — no changes to your OpenClaw config are
needed.
</Tip>

## Related

<CardGroup cols={2}>
  <Card
    title="MLflow AI Gateway Docs"
    href="https://mlflow.org/docs/latest/genai/governance/ai-gateway/"
    icon="book"
  >
    Official MLflow AI Gateway documentation.
  </Card>
  <Card
    title="LiteLLM provider"
    href="/providers/litellm"
    icon="layers"
  >
    Alternative multi-provider proxy.
  </Card>
</CardGroup>
