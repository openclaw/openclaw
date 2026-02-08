---
summary: "Brug Qianfans samlede API til at få adgang til mange modeller i OpenClaw"
read_when:
  - Du vil have en enkelt API-nøgle til mange LLM'er
  - Du har brug for vejledning til opsætning af Baidu Qianfan
title: "Qianfan"
x-i18n:
  source_path: providers/qianfan.md
  source_hash: 2ca710b422f190b6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:30Z
---

# Qianfan udbyderguide

Qianfan er Baidus MaaS-platform og leverer et **samlet API**, der dirigerer forespørgsler til mange modeller bag et enkelt
endpoint og én API-nøgle. Den er OpenAI-kompatibel, så de fleste OpenAI-SDK'er virker ved blot at skifte base-URL.

## Forudsætninger

1. En Baidu Cloud-konto med adgang til Qianfan API
2. En API-nøgle fra Qianfan-konsollen
3. OpenClaw installeret på dit system

## Sådan får du din API-nøgle

1. Besøg [Qianfan-konsollen](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Opret en ny applikation eller vælg en eksisterende
3. Generér en API-nøgle (format: `bce-v3/ALTAK-...`)
4. Kopiér API-nøglen til brug med OpenClaw

## CLI-opsætning

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Relateret dokumentation

- [OpenClaw Konfiguration](/gateway/configuration)
- [Modeludbydere](/concepts/model-providers)
- [Agent-opsætning](/concepts/agent)
- [Qianfan API-dokumentation](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
