---
summary: "Use Huawei Cloud ModelArts MAAS (Model as a Service) in OpenClaw"
read_when:
  - You want to use Huawei Cloud MAAS models
  - You need setup instructions for Huawei MAAS auth + model selection
title: "Huawei Cloud MAAS"
---

# Huawei Cloud MAAS

Huawei Cloud ModelArts MAAS (Model as a Service) provides access to various AI models through a unified API. OpenClaw supports Huawei MAAS with API key authentication.

## Authentication

### Option A: Huawei MAAS API key

**Best for:** standard API access and usage-based billing.
Create your API key in the Huawei Cloud Console:

[Huawei Cloud MAAS API Key Management](https://console.huaweicloud.com/modelarts/?region=cn-southwest-2#/model-studio/authmanage)

### CLI setup

```bash
openclaw onboard
# choose: Huawei Cloud MAAS API key

# or non-interactive
openclaw onboard --huawei-maas-api-key "$HUAWEI_MAAS_API_KEY"
```

### Config snippet

```json5
{
  env: { HUAWEI_MAAS_API_KEY: "your-api-key" },
  agents: { defaults: { model: { primary: "huawei-maas/deepseek-v3.2" } } },
}
```

## Model discovery

OpenClaw automatically discovers available models from Huawei Cloud MAAS API. If discovery fails, it falls back to the built-in model list.

## Supported models

### Default models

OpenClaw includes the following default models for Huawei MAAS:

- `huawei-maas/Kimi-K2` - Kimi K2
- `huawei-maas/deepseek-v3.2` - Deepseek V3.2
- `huawei-maas/qwen3-32b` - Qwen3 32b
- `huawei-maas/DeepSeek-R1` - DeepSeek R1 (reasoning model)
- `huawei-maas/deepseek-v3.2-exp` - Deepseek V3.2 Exp
- `huawei-maas/deepseek-v3.1-terminus` - Deepseek V3.1 Terminus
- `huawei-maas/qwen3-30b-a3b` - Qwen3 30b A3b
- `huawei-maas/qwen3-coder-480b-a35b-instruct` - Qwen3 Coder 480b A35b Instruct
- `huawei-maas/qwen3-235b-a22b` - Qwen3 235b A22b
- `huawei-maas/longcat-flash-chat` - Longcat Flash Chat

## CLI commands

### Check model status

```bash
openclaw models status
```

### List available models

```bash
openclaw models list
```

## Troubleshooting

**API key not found**

- Ensure the `HUAWEI_MAAS_API_KEY` environment variable is set correctly
- Verify the API key is valid in the Huawei Cloud Console
- Re-run onboarding with the correct API key

**Model discovery failed**

- Check your network connection to Huawei Cloud MAAS API
- Verify your API key has sufficient permissions
- OpenClaw will automatically fall back to the built-in model list

**Authentication errors**

- Ensure your API key is not expired
- Check that you have the correct region settings in your Huawei Cloud account
- Verify the API endpoint is accessible from your network

More: [/gateway/troubleshooting](/gateway/troubleshooting) and [/help/faq](/help/faq).
