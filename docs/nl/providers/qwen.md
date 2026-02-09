---
summary: "Gebruik Qwen OAuth (gratis tier) in OpenClaw"
read_when:
  - Je wilt Qwen gebruiken met OpenClaw
  - Je wilt gratis OAuth-toegang tot Qwen Coder
title: "Qwen"
---

# Qwen

Qwen biedt een gratis OAuth-flow voor Qwen Coder- en Qwen Vision-modellen
(2.000 verzoeken per dag, onder voorbehoud van Qwen-rate limits).

## Plugin inschakelen

```bash
openclaw plugins enable qwen-portal-auth
```

Start de Gateway opnieuw nadat je deze hebt ingeschakeld.

## Authenticatie

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Dit voert de Qwen device-code OAuth-flow uit en schrijft een providervermelding
naar je `models.json` (plus een `qwen`-alias voor snel wisselen).

## Model-ID's

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Wissel van model met:

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen Code CLI-aanmelding hergebruiken

Als je al bent aangemeld met de Qwen Code CLI, synchroniseert OpenClaw
referenties vanuit `~/.qwen/oauth_creds.json` wanneer het de auth store laadt. Je hebt nog
steeds een `models.providers.qwen-portal`-vermelding nodig (gebruik de bovenstaande
aanmeldopdracht om er een te maken).

## Notities

- Tokens worden automatisch vernieuwd; voer de aanmeldopdracht opnieuw uit als het vernieuwen mislukt of de toegang wordt ingetrokken.
- Standaard basis-URL: `https://portal.qwen.ai/v1` (overschrijf met
  `models.providers.qwen-portal.baseUrl` als Qwen een ander endpoint aanbiedt).
- Zie [Model providers](/concepts/model-providers) voor providerbrede regels.
