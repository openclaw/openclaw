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

| Property | Value                    |
| -------- | ------------------------ |
| Provider | `openai` (via `api_base`) |
| Auth     | Managed by the gateway   |
| API      | OpenAI-compatible        |

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
  <Step title="Point OpenClaw to the gateway">
    ```bash
    export OPENAI_API_BASE=http://localhost:5000/gateway/openai/v1
    export OPENAI_API_KEY=unused  # provider keys are managed by the gateway
    ```
  </Step>
  <Step title="Set a default model">
    Use your gateway endpoint name as the model:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "openai/my-chat-endpoint" },
        },
      },
    }
    ```
  </Step>
</Steps>

### Config file example

```json5
{
  env: {
    OPENAI_API_BASE: "http://localhost:5000/gateway/openai/v1",
    OPENAI_API_KEY: "unused",
  },
  agents: {
    defaults: {
      model: { primary: "openai/my-chat-endpoint" },
    },
  },
}
```

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
