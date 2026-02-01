# Vertex AI Anthropic (Claude on GCP)

OpenClaw supports Claude models hosted on Google Cloud Vertex AI. This allows you to use your GCP credits directly without routing through OpenRouter or other intermediaries.

## Benefits

- **No middleman fees**: Use your GCP credits directly (no 5% OpenRouter fee)
- **Same Claude experience**: Full feature parity with direct Anthropic API
- **GCP integration**: Uses your existing gcloud credentials

## Prerequisites

1. **GCP Project** with Vertex AI API enabled
2. **Claude models enabled** in your project's Model Garden
3. **gcloud CLI** configured with Application Default Credentials

## Setup

### 1. Enable Claude on Vertex AI

1. Go to [Vertex AI Model Garden](https://console.cloud.google.com/vertex-ai/model-garden)
2. Search for "Claude" and enable the models you want to use
3. Note your project ID and region (e.g., `us-east5`)

### 2. Configure gcloud ADC

```bash
gcloud auth application-default login
```

Or use a service account:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

### 3. Set Environment Variables

```bash
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=us-east5  # or your region
```

### 4. Verify Setup

```bash
openclaw models list | grep vertex-anthropic
```

## Available Models

| Model                | ID                              | Features          |
| -------------------- | ------------------------------- | ----------------- |
| Claude Opus 4.5      | `claude-opus-4-5@20251101`      | Reasoning, Vision |
| Claude Sonnet 4.5    | `claude-sonnet-4-5@20250929`    | Reasoning, Vision |
| Claude Opus 4.1      | `claude-opus-4-1@20250805`      | Reasoning, Vision |
| Claude Haiku 4.5     | `claude-haiku-4-5@20251001`     | Reasoning, Vision |
| Claude Opus 4        | `claude-opus-4@20250514`        | Reasoning, Vision |
| Claude Sonnet 4      | `claude-sonnet-4@20250514`      | Reasoning, Vision |
| Claude 3.7 Sonnet    | `claude-3-7-sonnet@20250219`    | Reasoning, Vision |
| Claude 3.5 Sonnet v2 | `claude-3-5-sonnet-v2@20241022` | Vision            |
| Claude 3.5 Haiku     | `claude-3-5-haiku@20241022`     | Vision            |

## Configuration

### Using Default Model

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "vertex-anthropic/claude-opus-4-5@20251101"
      }
    }
  }
}
```

### Custom Configuration

You can also manually configure the provider:

```json
{
  "models": {
    "providers": {
      "vertex-anthropic": {
        "baseUrl": "https://us-east5-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT/locations/us-east5/publishers/anthropic/models",
        "api": "anthropic-messages",
        "auth": "token",
        "models": [
          {
            "id": "claude-opus-4-5@20251101",
            "name": "Claude Opus 4.5",
            "contextWindow": 200000,
            "maxTokens": 32768,
            "reasoning": true,
            "input": ["text", "image"]
          }
        ]
      }
    }
  }
}
```

## Regions

Claude on Vertex AI is available in these regions:

- `us-east5` (Ohio)
- `europe-west1` (Belgium)
- `asia-southeast1` (Singapore)

Check [Vertex AI documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude) for the latest availability.

## Troubleshooting

### "No API key found for provider vertex-anthropic"

Ensure gcloud ADC is configured:

```bash
gcloud auth application-default login
```

### "Project not found"

Set the project environment variable:

```bash
export GOOGLE_CLOUD_PROJECT=your-project-id
```

### "Location not found"

Set the location where Claude is enabled:

```bash
export GOOGLE_CLOUD_LOCATION=us-east5
```

### "Model not found"

Ensure you've enabled Claude models in your project's Model Garden.
