---
summary: "Gamitin ang pinag-isang API ng Qianfan para ma-access ang maraming model sa OpenClaw"
read_when:
  - Gusto mo ng iisang API key para sa maraming LLM
  - Kailangan mo ng gabay sa setup ng Baidu Qianfan
title: "Qianfan"
---

# Gabay sa Qianfan Provider

Qianfan is Baidu's MaaS platform, provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## Mga paunang kinakailangan

1. Isang Baidu Cloud account na may access sa Qianfan API
2. Isang API key mula sa Qianfan console
3. Naka-install ang OpenClaw sa iyong system

## Pagkuha ng Iyong API Key

1. Bisitahin ang [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Gumawa ng bagong application o pumili ng umiiral na
3. Bumuo ng API key (format: `bce-v3/ALTAK-...`)
4. Kopyahin ang API key para gamitin sa OpenClaw

## Setup ng CLI

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Kaugnay na docs

- [Konpigurasyon ng OpenClaw](/gateway/configuration)
- [Mga Model Provider](/concepts/model-providers)
- [Setup ng Agent](/concepts/agent)
- [Dokumentasyon ng Qianfan API](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
