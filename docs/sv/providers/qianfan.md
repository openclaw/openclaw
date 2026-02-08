---
summary: "Använd Qianfans enhetliga API för att få åtkomst till många modeller i OpenClaw"
read_when:
  - Du vill ha en enda API-nyckel för många LLM:er
  - Du behöver vägledning för konfiguration av Baidu Qianfan
title: "Qianfan"
x-i18n:
  source_path: providers/qianfan.md
  source_hash: 2ca710b422f190b6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:11Z
---

# Guide för Qianfan-leverantören

Qianfan är Baidus MaaS-plattform och tillhandahåller ett **enhetligt API** som dirigerar förfrågningar till många modeller bakom en enda
endpoint och API-nyckel. Den är OpenAI-kompatibel, så de flesta OpenAI-SDK:er fungerar genom att byta bas-URL.

## Förutsättningar

1. Ett Baidu Cloud-konto med åtkomst till Qianfan API
2. En API-nyckel från Qianfan-konsolen
3. OpenClaw installerat på ditt system

## Skaffa din API-nyckel

1. Besök [Qianfan-konsolen](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Skapa en ny applikation eller välj en befintlig
3. Generera en API-nyckel (format: `bce-v3/ALTAK-...`)
4. Kopiera API-nyckeln för användning med OpenClaw

## CLI-konfigurering

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Relaterad dokumentation

- [OpenClaw-konfiguration](/gateway/configuration)
- [Modellleverantörer](/concepts/model-providers)
- [Agentkonfigurering](/concepts/agent)
- [Qianfan API-dokumentation](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
