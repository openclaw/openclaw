---
summary: "Use Anthropic Claude models via Google Cloud Vertex AI in OpenClaw"
read_when:
  - You want to use Claude models through Vertex AI
  - You want to use a GCP service account for Claude
  - You want to avoid direct Anthropic API keys
title: "Vertex AI Anthropic"
---

# Vertex AI Anthropic

Run Anthropic **Claude** models through **Google Cloud Vertex AI** instead of the direct Anthropic API. This is useful when your organization manages access through GCP projects and service accounts.

## Prerequisites

1. A GCP project with the **Vertex AI API** enabled
2. Claude models enabled in your Vertex AI Model Garden
3. One of the following authentication methods:
   - A service account JSON key file
   - `GOOGLE_APPLICATION_CREDENTIALS` pointing to a key file
   - Application Default Credentials via `gcloud auth application-default login`

## Environment variables

| Variable                         | Required | Default        | Description                              |
| -------------------------------- | -------- | -------------- | ---------------------------------------- |
| `ANTHROPIC_VERTEX_PROJECT_ID`    | Yes      | -              | Your GCP project ID                      |
| `ANTHROPIC_VERTEX_REGION`        | No       | `europe-west1` | Vertex AI region                         |
| `SERVICE_ACCOUNT_KEY_FILE`       | No       | -              | Path to service account JSON key         |
| `GOOGLE_APPLICATION_CREDENTIALS` | No       | -              | Standard GCP credentials path (fallback) |

At least one authentication source must be available (key file or ADC).

## Setup

### CLI setup

```bash
# Set required environment variables
export ANTHROPIC_VERTEX_PROJECT_ID="my-gcp-project"
export SERVICE_ACCOUNT_KEY_FILE="/path/to/service-account-key.json"

# Optional: set region (defaults to europe-west1)
export ANTHROPIC_VERTEX_REGION="us-central1"

# Run onboarding
openclaw onboard
# choose: GCP Service Account / ADC
```

### Config snippet

```json5
{
  env: {
    ANTHROPIC_VERTEX_PROJECT_ID: "my-gcp-project",
    SERVICE_ACCOUNT_KEY_FILE: "/path/to/service-account-key.json",
  },
  agents: {
    defaults: {
      model: {
        primary: "vertex-anthropic/claude-sonnet-4-5@20250929",
      },
    },
  },
}
```

## Available models

| Model ID                     | Name              | Context | Max output |
| ---------------------------- | ----------------- | ------- | ---------- |
| `claude-opus-4-6`            | Claude Opus 4.6   | 200k    | 128k       |
| `claude-sonnet-4-5@20250929` | Claude Sonnet 4.5 | 200k    | 64k        |

Both models support reasoning/thinking and image input.

## Authentication flow

Authentication is handled internally by `google-auth-library`. The priority order is:

1. `SERVICE_ACCOUNT_KEY_FILE` - explicit service account key path
2. `GOOGLE_APPLICATION_CREDENTIALS` - standard GCP environment variable
3. Application Default Credentials - from `gcloud auth application-default login`

Tokens are automatically refreshed before expiry.

## Differences from direct Anthropic API

- No `ANTHROPIC_API_KEY` needed
- Billing goes through your GCP project
- Requests route through `{region}-aiplatform.googleapis.com`
- Prompt caching behavior may differ from the direct API
