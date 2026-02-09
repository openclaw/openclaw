---
summary: "Gebruik de uniforme API van Qianfan om toegang te krijgen tot veel modellen in OpenClaw"
read_when:
  - Je wilt één API-sleutel voor veel LLM's
  - Je hebt begeleiding nodig bij het instellen van Baidu Qianfan
title: "Qianfan"
---

# Qianfan Provider-handleiding

Qianfan is het MaaS-platform van Baidu en biedt een **uniforme API** die verzoeken naar veel modellen achter één enkel
endpoint en één API-sleutel routeert. Het is OpenAI-compatibel, dus de meeste OpenAI-SDK's werken door simpelweg de basis-URL te wijzigen.

## Vereisten

1. Een Baidu Cloud-account met Qianfan API-toegang
2. Een API-sleutel uit de Qianfan-console
3. OpenClaw geïnstalleerd op je systeem

## Je API-sleutel verkrijgen

1. Ga naar de [Qianfan-console](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Maak een nieuwe applicatie aan of selecteer een bestaande
3. Genereer een API-sleutel (indeling: `bce-v3/ALTAK-...`)
4. Kopieer de API-sleutel voor gebruik met OpenClaw

## CLI-installatie

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Gerelateerde documentatie

- [OpenClaw-configuratie](/gateway/configuration)
- [Modelproviders](/concepts/model-providers)
- [Agent-installatie](/concepts/agent)
- [Qianfan API-documentatie](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
