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

## CLI setup

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Related Documentation

- [OpenClaw Configuration](/gateway/configuration)
- [Model Providers](/concepts/model-providers)
- [Agent Setup](/concepts/agent)
- [Qianfan API Documentation](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
