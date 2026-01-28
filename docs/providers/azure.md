# Azure Provider

Azure supports deploying OpenAI-compatible models through Azure infrastructure. Moltbot's Azure provider allows you to use various models deployed on Azure, including OpenAI models (GPT-4, GPT-3.5), DeepSeek, and other compatible models.

## Prerequisites

Before using Azure with Moltbot, you need:

1. An active Azure subscription with Azure AI access
2. An Azure resource with model deployments
3. Your Azure API key and endpoint
4. A deployed model (OpenAI, DeepSeek, or other compatible models)

## Configuration

### Environment Variables

The easiest way to configure Azure is through environment variables:

```bash
export AZURE_ENDPOINT="https://your-resource.cognitiveservices.azure.com"
export AZURE_API_KEY="your-api-key-here"
export AZURE_DEPLOYMENT="your-deployment-name"
export AZURE_API_VERSION="2024-02-01"  # Optional, defaults to 2024-08-01-preview
```

#### Required Variables

- `AZURE_ENDPOINT`: Your Azure resource endpoint URL
  - Format: `https://{resource-name}.cognitiveservices.azure.com` or `https://{region}.api.cognitive.microsoft.com`
  - Find this in the Azure Portal under your resource's "Keys and Endpoint" section

- `AZURE_API_KEY`: Your Azure API key
  - Find this in the Azure Portal under "Keys and Endpoint"
  - Either KEY 1 or KEY 2 will work

- `AZURE_DEPLOYMENT`: The name of your model deployment
  - This is the deployment name you configured in Azure AI Studio
  - Must match exactly as configured in Azure
  - Examples: `gpt-4`, `gpt-5.2`, `deepseek-chat`

#### Optional Variables

- `AZURE_API_VERSION`: Azure API version
  - Default: `2024-08-01-preview`
  - Use a stable API version for production workloads
  - Common versions: `2024-02-01`, `2024-08-01-preview`

### models.json Configuration

Alternatively, you can configure Azure in your `models.json` file:

```json
{
  "providers": {
    "azure": {
      "baseUrl": "https://your-resource.cognitiveservices.azure.com/openai/deployments/your-deployment/chat/completions?api-version=2024-02-01",
      "apiKey": "AZURE_API_KEY",
      "api": "openai-completions",
      "headers": {
        "api-key": "${AZURE_API_KEY}"
      },
      "models": [
        {
          "id": "",
          "name": "Azure GPT-4",
          "reasoning": false,
          "input": ["text"],
          "cost": {
            "input": 10,
            "output": 30,
            "cacheRead": 2.5,
            "cacheWrite": 12.5
          },
          "contextWindow": 200000,
          "maxTokens": 16384,
          "compat": {
            "maxTokensField": "max_completion_tokens"
          }
        }
      ]
    }
  }
}
```

## Supported Models

Azure supports various OpenAI-compatible models:

### OpenAI Models
- **GPT-4 Series**: `gpt-4`, `gpt-4-turbo`, `gpt-4-vision`
- **GPT-5.2**: Latest models with extended context
- **GPT-3.5**: `gpt-35-turbo` (note the hyphen instead of dot)
- **o1/o3 Models**: Reasoning models with extended thinking

### DeepSeek Models
- **DeepSeek-V3**: Latest DeepSeek model
- **DeepSeek-Chat**: General conversation model

### Other Compatible Models
Any OpenAI API-compatible model deployed on Azure will work with this provider.

## Usage

### With Environment Variables

```bash
# Configure Azure
export AZURE_ENDPOINT="https://eastus2.api.cognitive.microsoft.com"
export AZURE_API_KEY="your-key-here"
export AZURE_DEPLOYMENT="gpt-5.2"
export AZURE_API_VERSION="2024-02-01"

# Use with Moltbot
moltbot agent --message "Hello" --model azure/gpt-5.2
```

### List Available Models

```bash
moltbot models list | grep azure
```

Expected output:
```
azure/{deployment-name}  Azure {deployment-name}  ...
```

## Deployment Name Mapping

Azure uses deployment names instead of model IDs. When you configure `AZURE_DEPLOYMENT=gpt-5.2`, Moltbot will expose this as:

```
azure/gpt-5.2
```

The deployment name becomes the model identifier in Moltbot.

## Important Notes

### URL Construction

Azure has a specific URL format that differs from standard OpenAI:

```
Standard OpenAI:  https://api.openai.com/v1/chat/completions
Azure:           https://{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={version}
```

Moltbot automatically handles URL construction through an internal URL fix middleware, so you don't need to worry about the format differences.

### API Compatibility

Azure's API is compatible with OpenAI's API format but uses:
- Header: `api-key` instead of `Authorization: Bearer`
- Parameter: `max_completion_tokens` instead of `max_tokens` (for newer models)
- Query parameter: `api-version` is required

## Troubleshooting

### HTTP 404 Errors

**Problem**: Getting 404 errors when making API calls

**Solutions**:
1. Verify your `AZURE_ENDPOINT` is correct (should not include `/openai/deployments/`)
2. Verify your `AZURE_DEPLOYMENT` name matches exactly in Azure Portal
3. Check that `AZURE_API_VERSION` is supported by your deployment
4. Ensure your Azure resource has the model deployed

### Authentication Errors

**Problem**: 401 Unauthorized errors

**Solutions**:
1. Verify `AZURE_API_KEY` is correct
2. Check that the API key hasn't been regenerated in Azure Portal
3. Ensure the key matches the endpoint (don't mix keys from different resources)

### Unsupported Parameter Errors

**Problem**: `Unsupported parameter: 'max_tokens'` error

**Solution**: Newer Azure models require `max_completion_tokens` instead of `max_tokens`. Moltbot handles this automatically through the `compat.maxTokensField` setting.

### Model Not Found

**Problem**: Model doesn't appear in `moltbot models list`

**Solutions**:
1. Check all required environment variables are set
2. Verify `AZURE_DEPLOYMENT` is exactly as configured in Azure
3. Restart Moltbot after changing environment variables

## Security Best Practices

1. **Never commit API keys**: Use environment variables or Azure Key Vault
2. **Rotate keys regularly**: Regenerate your API keys periodically
3. **Use RBAC**: Configure role-based access control in Azure
4. **Monitor usage**: Enable Azure Monitor for usage tracking
5. **Set spending limits**: Configure budgets in Azure Cost Management

## API Versions

Azure uses API versioning. Common versions:

- `2024-02-01`: Stable production version
- `2024-08-01-preview`: Preview with latest features
- `2023-12-01`: Older stable version

Check [Azure OpenAI API documentation](https://learn.microsoft.com/azure/ai-services/openai/reference) for the latest versions.

## Comparison with Standard OpenAI

| Feature | Azure | Standard OpenAI |
|---------|-------|-----------------|
| Endpoint | Regional (e.g., eastus2) | Global (api.openai.com) |
| Authentication | api-key header | Bearer token |
| Deployment | Named deployments | Model IDs |
| Billing | Azure subscription | OpenAI account |
| Data residency | Regional | Global |
| Enterprise features | Azure integration | OpenAI org settings |

## Azure Speech Service (TTS)

Azure Speech Service provides high-quality text-to-speech with neural voices in 100+ languages.

### Configuration

Add Azure TTS to your `moltbot.json`:

```json
{
  "messages": {
    "tts": {
      "provider": "azure",
      "azure": {
        "apiKey": "your-speech-api-key",
        "region": "eastus2",
        "voice": "zh-CN-XiaoxiaoNeural",
        "lang": "zh-CN",
        "outputFormat": "audio-24khz-48kbitrate-mono-mp3"
      }
    }
  }
}
```

### Environment Variables

```bash
export AZURE_SPEECH_API_KEY="your-speech-api-key"
export AZURE_SPEECH_REGION="eastus2"
```

### Popular Voices

**Chinese**:
- `zh-CN-XiaoxiaoNeural` - Female, natural and friendly
- `zh-CN-YunxiNeural` - Male, warm and steady
- `zh-CN-YunyangNeural` - Male, professional news anchor

**English**:
- `en-US-JennyNeural` - Female, friendly assistant
- `en-US-GuyNeural` - Male, professional
- `en-US-AriaNeural` - Female, conversational

**Japanese**:
- `ja-JP-NanamiNeural` - Female, polite and clear
- `ja-JP-KeitaNeural` - Male, friendly

See [full voice list](https://learn.microsoft.com/azure/ai-services/speech-service/language-support?tabs=tts).

### Output Formats

Common formats for Moltbot:
- `audio-24khz-48kbitrate-mono-mp3` - Default, good quality
- `audio-48khz-96kbitrate-mono-mp3` - High quality
- `webm-24khz-16bit-mono-opus` - WebM for web
- `ogg-24khz-16bit-mono-opus` - OGG for compatibility

### Advantages over Edge TTS

- **Higher quality**: Neural voices with better prosody
- **More voices**: 400+ neural voices vs Edge's limited set
- **Custom voices**: Create custom neural voices (preview)
- **SSML control**: Fine-grained control over speech
- **Unified billing**: Same Azure subscription as GPT models

## Additional Resources

- [Azure AI Services Documentation](https://learn.microsoft.com/azure/ai-services/)
- [Azure OpenAI Quickstart](https://learn.microsoft.com/azure/ai-services/openai/quickstart)
- [Azure Speech Service](https://learn.microsoft.com/azure/ai-services/speech-service/)
- [Speech TTS API Reference](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech)
- [Model Deployments](https://learn.microsoft.com/azure/ai-services/openai/how-to/create-resource)
