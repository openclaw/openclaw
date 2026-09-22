---
summary: "Databricks Unity Gateway setup for OpenClaw"
title: "Databricks"
read_when:
  - You want to route OpenClaw models through Databricks
  - You use Unity Gateway model services
---

OpenClaw can use Databricks model services through the unified MLflow Chat Completions API.

| Property      | Value                                      |
| ------------- | ------------------------------------------ |
| Provider      | `databricks`                               |
| Auth          | `DATABRICKS_TOKEN`                         |
| Workspace     | `DATABRICKS_HOST`                          |
| API           | OpenAI-compatible Chat Completions         |
| Base URL      | `https://<workspace>/ai-gateway/mlflow/v1` |
| Default model | `databricks/system.ai.claude-sonnet-4-5`   |

Databricks model services use fully qualified Unity Catalog names such as
`system.ai.claude-sonnet-4-5` and `system.ai.gpt-5-6-sol`. Custom model
services can be selected by their fully qualified name as well.

## Install

```bash
openclaw plugins install @openclaw/databricks-provider
```

## Configure

Set the workspace host and token:

```bash
export DATABRICKS_HOST="https://dbc-example.cloud.databricks.com"
export DATABRICKS_TOKEN="..."
```

Then run onboarding:

```bash
openclaw onboard --auth-choice databricks-token
```

For non-interactive setup:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice databricks-token \
  --databricks-token "$DATABRICKS_TOKEN"
```

`DATABRICKS_HOST` must be present in the environment for non-interactive setup.

On a fresh configuration, onboarding selects `databricks/system.ai.claude-sonnet-4-5` as the primary model. If a primary model is already configured, onboarding preserves it.

## Select a model

```json5
{
  agents: {
    defaults: {
      model: { primary: "databricks/system.ai.claude-sonnet-4-5" },
    },
  },
}
```

OpenClaw also accepts arbitrary Databricks model-service names:

```text
databricks/<catalog>.<schema>.<model-service>
```

Requests are sent to Databricks' unified OpenAI-compatible endpoint, so the same
OpenClaw provider works across Databricks-backed Anthropic, OpenAI, Gemini, and
Databricks-hosted models supported by that API.

## Production authentication

Databricks personal access tokens work for development. For production,
Databricks recommends machine-to-machine OAuth credentials. Keep tokens out of
`openclaw.json` and source control; use environment-backed secret references
or the normal OpenClaw credential store.
