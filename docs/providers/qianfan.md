---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use Qianfan's unified API to access many models in OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a single API key for many LLMs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need Baidu Qianfan setup guidance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Qianfan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Qianfan Provider Guide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Qianfan is Baidu's MaaS platform, provides a **unified API** that routes requests to many models behind a single（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prerequisites（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. A Baidu Cloud account with Qianfan API access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. An API key from the Qianfan console（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. OpenClaw installed on your system（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Getting Your API Key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Visit the [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create a new application or select an existing one（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Generate an API key (format: `bce-v3/ALTAK-...`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Copy the API key for use with OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice qianfan-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related Documentation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenClaw Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Model Providers](/concepts/model-providers)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Agent Setup](/concepts/agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Qianfan API Documentation](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
