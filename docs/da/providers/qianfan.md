---
summary: "Brug Qianfans samlede API til at få adgang til mange modeller i OpenClaw"
read_when:
  - Du vil have en enkelt API-nøgle til mange LLM'er
  - Du har brug for vejledning til opsætning af Baidu Qianfan
title: "Qianfan"
---

# Qianfan udbyderguide

Qianfan er Baidu's MaaS-platform, giver en **samlet API** som ruter anmoder om til mange modeller bag et enkelt
endepunkt og API-nøgle. Det er OpenAI-kompatibelt, så de fleste OpenAI SDKs virker ved at skifte grund-URL.

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
