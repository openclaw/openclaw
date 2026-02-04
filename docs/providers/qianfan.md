---
summary: "Use Qianfan's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You need Baidu Qianfan setup guidance
title: "Qianfan"
---

# Qianfan Provider Guide

Qianfan is Baidu's MaaS platform, provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## Prerequisites

1. A Baidu Cloud account with Qianfan API access
2. An API key from the Qianfan console
3. OpenClaw installed on your system

## Getting Your API Key

1. Visit the [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Create a new application or select an existing one
3. Generate an API key (format: `bce-v3/ALTAK-...`)
4. Copy the API key for use with OpenClaw

## Installation

### Install OpenClaw

```bash
# Using npm
npm install -g openclaw

# Using pnpm
pnpm add -g openclaw

# Using bun
bun add -g openclaw
```

### Verify Installation

```bash
openclaw --version
```

## Configuration Methods

### Method 1: Environment Variable (Recommended)

Set the `QIANFAN_API_KEY` environment variable:

```bash
# Bash/Zsh
export QIANFAN_API_KEY="bce-v3/ALTAK-your-api-key-here"

# Fish
set -gx QIANFAN_API_KEY "bce-v3/ALTAK-your-api-key-here"

# PowerShell
$env:QIANFAN_API_KEY = "bce-v3/ALTAK-your-api-key-here"
```

Add to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) for persistence:

```bash
echo 'export QIANFAN_API_KEY="bce-v3/ALTAK-your-api-key-here"' >> ~/.bashrc
source ~/.bashrc
```

### Method 2: Interactive Onboarding

Run the onboarding wizard:

```bash
openclaw onboard --auth-choice qianfan-api-key
```

Follow the prompts to enter your API key.



### Method 3: Configuration File

Configure manually via `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "qianfan": {
        "baseUrl": "https://qianfan.baidubce.com/v2",
        "api": "openai-completions",
        "apiKey": "bce-v3/ALTAK-your-api-key-here",
        "models": [
          {
            "id": "deepseek-v3.2",
            "name": "DeepSeek-V3.2",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 98304,
            "maxTokens": 32768
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "qianfan/deepseek-v3.2"
      }
    }
  }
}
```

## Usage

### Start a Chat Session

```bash
# Using default QIANFAN model
openclaw chat

# Explicitly specify QIANFAN model
openclaw chat --model qianfan/deepseek-v3.2
```

### Send a Single Message

```bash
openclaw message send "Hello, qianfan!"
```

### Use in Agent Mode

```bash
openclaw agent --model qianfan/deepseek-v3.2
```

### Check Configuration Status

```bash
# View current configuration
openclaw config get

# Check provider status
openclaw channels status --probe
```

## Model Details

| Property          | Value                   |
| ----------------- | ----------------------- |
| Provider          | `qianfan`               |
| Model ID          | `deepseek-v3.2`         |
| Model Reference   | `qianfan/deepseek-v3.2` |
| Context Window    | 98,304 tokens           |
| Max Output Tokens | 32,768 tokens           |
| Reasoning         | Yes                     |
| Input Types       | Text                    |

## Available Models

The default model is `deepseek-v3.2`. You can configure additional models in your config file:

```json
{
  "models": {
    "providers": {
      "qianfan": {
        "models": [
          {
            "id": "deepseek-v3",
            "name": "DeepSeek-V3",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 131072,
            "maxTokens": 16384
          },
          {
            "id": "ernie-x1.1",
            "name": "ERNIE-X1.1",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 65536,
            "maxTokens": 65536
          }
        ]
      }
    }
  }
}
```

## Troubleshooting

### API Key Not Found

If you see "No API key found for provider qianfan":

1. Verify the environment variable is set:

   ```bash
   echo $QIANFAN_API_KEY
   ```

2. Re-run onboarding:

   ```bash
   openclaw onboard --auth-choice qianfan-api-key
   ```

3. Check auth profiles:
   ```bash
   cat ~/.openclaw/auth-profiles.json
   ```

### Authentication Errors

If you receive authentication errors:

1. Verify your API key format starts with `bce-v3/ALTAK-`
2. Check that your Qianfan application has the necessary permissions
3. Ensure your API key hasn't expired

### Connection Issues

If you can't connect to the Qianfan API:

1. Check your network connection
2. Verify the API endpoint is accessible:

   ```bash
   curl -I https://qianfan.baidubce.com/v2
   ```

3. Check if you're behind a proxy and configure accordingly

### Model Not Found

If the model isn't recognized:

1. Ensure you're using the correct model reference format: `qianfan/<model-id>`
2. Check available models in your config
3. Verify the model ID matches what's available in Qianfan

## API Reference

### Endpoint

```
https://qianfan.baidubce.com/v2
```

### Authentication

The API uses bearer token authentication with your Qianfan API key.

### Request Format

OpenClaw uses the OpenAI-compatible API format (`openai-completions`), which Qianfan supports.

## Best Practices

1. **Secure your API key**: Never commit API keys to version control
2. **Use environment variables**: Prefer `QIANFAN_API_KEY` over config file storage
3. **Monitor usage**: Track your Qianfan API usage in the console
4. **Handle rate limits**: Implement appropriate retry logic for production use
5. **Test locally first**: Verify your configuration before deploying

## Related Documentation

- [OpenClaw Configuration](/configuration)
- [Model Providers](/models/providers)
- [Agent Setup](/agents)
- [Qianfan API Documentation](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
