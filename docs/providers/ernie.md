# ERNIE Provider Guide

ERNIE (Enhanced Representation through kNowledge IntEgration) is Baidu's large language model, accessible through the Qianfan API platform.

## Prerequisites

1. A Baidu Cloud account with Qianfan API access
2. An API key from the Qianfan console
3. OpenClaw installed on your system

## Getting Your API Key

1. Visit the [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application)
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

Set the `ERNIE_API_KEY` environment variable:

```bash
# Bash/Zsh
export ERNIE_API_KEY="bce-v3/ALTAK-your-api-key-here"

# Fish
set -gx ERNIE_API_KEY "bce-v3/ALTAK-your-api-key-here"

# PowerShell
$env:ERNIE_API_KEY = "bce-v3/ALTAK-your-api-key-here"
```

Add to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) for persistence:

```bash
echo 'export ERNIE_API_KEY="bce-v3/ALTAK-your-api-key-here"' >> ~/.bashrc
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
  --auth-choice token \
  --token-provider ernie \
  --token "bce-v3/ALTAK-your-api-key-here"
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
        "apiKey": "bce-v3/ALTAK-your-api-key-here",
        "models": [
          {
            "id": "ernie-5.0-thinking-preview",
            "name": "ERNIE 5.0",
            "reasoning": true,
            "input": ["text"],
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

### Use in Agent Mode

```bash
openclaw agent --model ernie/ernie-5.0-thinking-preview
```

### Check Configuration Status

```bash
# View current configuration
openclaw config get

# Check provider status
openclaw channels status --probe
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
| Input Types       | Text                               |

## Available Models

The default model is `ernie-5.0-thinking-preview`. You can configure additional models in your config file:

```json
{
  "models": {
    "providers": {
      "ernie": {
        "models": [
          {
            "id": "ernie-5.0-thinking-preview",
            "name": "ERNIE 5.0 Thinking",
            "reasoning": true,
            "contextWindow": 128000,
            "maxTokens": 65536
          },
          {
            "id": "ernie-4.0-turbo",
            "name": "ERNIE 4.0 Turbo",
            "reasoning": false,
            "contextWindow": 128000,
            "maxTokens": 4096
          }
        ]
      }
    }
  }
}
```

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

1. Ensure you're using the correct model reference format: `ernie/<model-id>`
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

## Examples

### Basic Chat

```bash
$ openclaw chat
> Hello! What can you do?
ERNIE: I'm ERNIE, Baidu's AI assistant. I can help you with:
- Answering questions
- Writing and editing text
- Code generation and debugging
- Analysis and summarization
- Creative writing
...
```

### Code Generation

```bash
$ openclaw chat --model ernie/ernie-5.0-thinking-preview
> Write a Python function to calculate fibonacci numbers

ERNIE: Here's a Python function to calculate Fibonacci numbers:

def fibonacci(n):
    """Calculate the nth Fibonacci number."""
    if n <= 0:
        return 0
    elif n == 1:
        return 1
    else:
        a, b = 0, 1
        for _ in range(2, n + 1):
            a, b = b, a + b
        return b
...
```

### Using with Different Models

```bash
# Use ERNIE 5.0 for reasoning tasks
openclaw chat --model ernie/ernie-5.0-thinking-preview

# Configure fallback models
openclaw config set agents.defaults.model.fallbacks '["anthropic/claude-sonnet-4-20250514"]'
```

## Best Practices

1. **Secure your API key**: Never commit API keys to version control
2. **Use environment variables**: Prefer `ERNIE_API_KEY` over config file storage
3. **Monitor usage**: Track your Qianfan API usage in the console
4. **Handle rate limits**: Implement appropriate retry logic for production use
5. **Test locally first**: Verify your configuration before deploying

## Related Documentation

- [OpenClaw Configuration](/configuration)
- [Providers Overview](/providers)
- [Qianfan API Documentation](https://cloud.baidu.com/doc/WENXINWORKSHOP/index.html)
