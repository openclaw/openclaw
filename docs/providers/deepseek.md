# DeepSeek Model Configuration Guide

## Overview

This document explains how to configure DeepSeek large language models in OpenClaw. DeepSeek is a powerful open-source large language model that supports various tasks and functionalities.

## Environment Variables Configuration

Add the following configuration to your `.env` file:

```bash
# DeepSeek API key
DEEPSEEK_API_KEY=your-deepseek-api-key-here
```

## OpenClaw Configuration Example

Add DeepSeek model provider to your `openclaw.json` configuration file:

```json
{
  "modelProviders": {
    "deepseek": {
      "kind": "openai",
      "baseURL": "https://api.deepseek.com",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "defaultModel": "deepseek-chat"
    }
  }
}
```

## Available DeepSeek Models

### 1. DeepSeek Chat Models
- `deepseek-chat`: General purpose chat model (maps to DeepSeek-V3)
- `deepseek-chat-v3`: Latest version of DeepSeek chat model

**Note**: The `deepseek-chat` model does not support the `reasoning: true` parameter. For reasoning capabilities, use the specific reasoning models mentioned below.

### 2. DeepSeek Coder Models
- `deepseek-coder-v2`: Latest code generation model (recommended)
- `deepseek-coder`: Legacy model (deprecated, use `deepseek-coder-v2` instead)

### 3. DeepSeek Reasoning Models
- `deepseek-reasoner`: Specialized model for complex reasoning tasks
- `deepseek-math`: Optimized for mathematical reasoning

## Model Configuration Examples

### Basic Chat Configuration
```json
{
  "models": {
    "deepseek-default": {
      "provider": "deepseek",
      "model": "deepseek-chat",
      "temperature": 0.7,
      "maxTokens": 2048
    }
  }
}
```

### Code Generation Configuration
```json
{
  "models": {
    "deepseek-coder": {
      "provider": "deepseek", 
      "model": "deepseek-coder-v2",
      "temperature": 0.2,
      "maxTokens": 4096
    }
  }
}
```

### Reasoning Task Configuration
```json
{
  "models": {
    "deepseek-reasoning": {
      "provider": "deepseek",
      "model": "deepseek-reasoner",
      "temperature": 0.3,
      "maxTokens": 4096
    }
  }
}
```

## Usage Examples

### 1. Agent Configuration
```json
{
  "agents": {
    "coding-assistant": {
      "model": "deepseek-coder",
      "systemPrompt": "You are an expert coding assistant..."
    },
    "general-assistant": {
      "model": "deepseek-default",
      "systemPrompt": "You are a helpful AI assistant..."
    }
  }
}
```

### 2. Skill Configuration
```json
{
  "skills": {
    "code-review": {
      "model": "deepseek-coder",
      "parameters": {
        "temperature": 0.1,
        "maxTokens": 1024
      }
    }
  }
}
```

## Best Practices

1. **API Key Security**: Always use environment variables for API keys
2. **Model Selection**: Choose the appropriate model for your specific task
3. **Error Handling**: Implement proper error handling for API failures
4. **Rate Limiting**: Respect DeepSeek API rate limits
5. **Cost Management**: Monitor token usage for cost control

## Troubleshooting

### Common Issues

1. **Authentication Errors**: Verify your `DEEPSEEK_API_KEY` is correctly set
2. **Model Not Found**: Ensure you're using the correct model identifier
3. **Rate Limit Exceeded**: Implement exponential backoff for retries
4. **Network Issues**: Check your internet connection and firewall settings

### Debugging Tips

- Enable debug logging in OpenClaw configuration
- Check the OpenClaw logs for detailed error messages
- Verify network connectivity to `api.deepseek.com`
- Test with simple prompts to isolate issues

## Additional Resources

- [DeepSeek Official Documentation](https://platform.deepseek.com/api-docs/)
- [OpenClaw Model Providers Documentation](https://docs.openclaw.ai/guides/model-providers)
- [API Rate Limits and Pricing](https://platform.deepseek.com/pricing)

## Support

For issues with DeepSeek integration:
1. Check the OpenClaw documentation
2. Review the DeepSeek API documentation  
3. Open an issue on the OpenClaw GitHub repository
4. Contact DeepSeek support for API-specific issues