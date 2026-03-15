# ERNIE Provider Guide

ERNIE (Enhanced Representation through kNowledge IntEgration) is Baidu's large language model, accessible through the Qianfan API platform.

## Prerequisites

1. A Baidu Cloud account with Qianfan API access
2. An API key from the Qianfan console
3. OpenClaw installed on your system

## Getting Your API Key

1. Visit the [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application)
2. Create a new application or select an existing one
3. Generate an API key
4. Copy the API key for use with OpenClaw

## Configuration Methods

### Method 1: Environment Variable (Recommended)

Set the `ERNIE_API_KEY` environment variable:

```bash
# Bash/Zsh
export ERNIE_API_KEY="your-api-key-here"  # pragma: allowlist secret

# Fish
set -gx ERNIE_API_KEY "your-api-key-here"  # pragma: allowlist secret

# PowerShell
$env:ERNIE_API_KEY = "your-api-key-here"  # pragma: allowlist secret
```

Add to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) for persistence:

```bash
echo 'export ERNIE_API_KEY="your-api-key-here"' >> ~/.bashrc  # pragma: allowlist secret
source ~/.bashrc
```

### Method 2: Interactive Onboarding

Run the onboarding wizard:

```bash
openclaw onboard --auth-choice ernie-api-key
```

Follow the prompts to enter your API key.

### Method 3: Non-Interactive Setup

For CI/CD or scripted setups:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice ernie-api-key \
  --ernie-api-key "your-api-key-here"  # pragma: allowlist secret
```

### Method 4: Configuration File

Add to your `~/.openclaw/config.json`:

```json
{
  "models": {
    "providers": {
      "ernie": {
        "baseUrl": "https://qianfan.baidubce.com/v2",
        "api": "openai-completions",
        "apiKey": "your-api-key-here",
        "models": [
          {
            "id": "ernie-5.0-thinking-preview",
            "name": "ERNIE 5.0",
            "reasoning": true,
            "input": ["text", "image"],
            "contextWindow": 128000,
            "maxTokens": 65536
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "ernie/ernie-5.0-thinking-preview"
      }
    }
  }
}
```

## Usage

### Start a Chat Session

```bash
# Using default ERNIE model
openclaw chat

# Explicitly specify ERNIE model
openclaw chat --model ernie/ernie-5.0-thinking-preview
```

### Send a Single Message

```bash
openclaw message send "Hello, ERNIE!"
```

### Check Configuration Status

```bash
# View current configuration
openclaw config get

# Check provider status
openclaw models status --probe
```

## Model Details

| Property          | Value                              |
| ----------------- | ---------------------------------- |
| Provider          | `ernie`                            |
| Model ID          | `ernie-5.0-thinking-preview`       |
| Model Reference   | `ernie/ernie-5.0-thinking-preview` |
| Context Window    | 128,000 tokens                     |
| Max Output Tokens | 65,536 tokens                      |
| Reasoning         | Yes                                |
| Input Types       | Text, Image                        |

## Troubleshooting

### API Key Not Found

If you see "No API key found for provider ernie":

1. Verify the environment variable is set:

   ```bash
   echo $ERNIE_API_KEY
   ```

2. Re-run onboarding:

   ```bash
   openclaw onboard --auth-choice ernie-api-key
   ```

### Authentication Errors

If you receive authentication errors:

1. Verify your API key is valid
2. Check that your Qianfan application has the necessary permissions
3. Ensure your API key has not expired

### Connection Issues

If you cannot connect to the Qianfan API:

1. Check your network connection
2. Verify the API endpoint is accessible:

   ```bash
   curl -I https://qianfan.baidubce.com/v2
   ```

3. Check if you are behind a proxy and configure accordingly

## API Reference

### Endpoint

```
https://qianfan.baidubce.com/v2
```

### Authentication

The API uses bearer token authentication with your Qianfan API key.

### Request Format

OpenClaw uses the OpenAI-compatible API format (`openai-completions`), which Qianfan supports.

## Related Documentation

- [OpenClaw Configuration](/configuration)
- [Providers Overview](/providers)
- [Qianfan API Documentation](https://cloud.baidu.com/doc/WENXINWORKSHOP/index.html)
