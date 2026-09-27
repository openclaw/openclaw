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
`system.ai.claude-sonnet-4-5`. Other system or custom model services can be
selected by fully qualified name as well; availability is owned by the target
Databricks workspace and region.

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

Non-interactive setup reads the workspace from `DATABRICKS_HOST`. When a Databricks
workspace is already configured, rotating the token does not need `DATABRICKS_HOST`
again; an explicit `DATABRICKS_HOST` replaces the configured workspace, and an invalid one
stops setup. A saved token is reused only while its workspace is the configured Databricks
provider, so a new workspace, or setup after `--reset`, needs `--databricks-token` or
`DATABRICKS_TOKEN`.

If a `databricks` provider is already configured for the same workspace URL with its own route
(for example a hand-written `/serving-endpoints` base URL), onboarding keeps that route, its
`api` setting and its model ids, and does not add a Unity Gateway default model. It sets the Unity
Gateway URL only for a new or different workspace. Interactive onboarding uses `DATABRICKS_HOST`
when it is set and asks for the workspace URL otherwise. Export `DATABRICKS_HOST` and
`DATABRICKS_TOKEN` in your shell or the Gateway environment: a project `.env` file cannot set them.

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

## Token lifetime

OpenClaw stores the token you give it and sends it as a bearer token. It does not
mint or refresh Databricks OAuth tokens. Personal access tokens work until they
expire or are revoked. Databricks OAuth access tokens, including machine-to-machine
tokens, expire after about an hour, so keep them in an environment-backed secret
reference that your own tooling refreshes. Keep tokens out of `openclaw.json` and
source control; use environment-backed secret references or the normal OpenClaw
credential store.
