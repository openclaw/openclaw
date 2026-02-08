---
summary: "Brug Qwen OAuth (gratis niveau) i OpenClaw"
read_when:
  - Du vil bruge Qwen med OpenClaw
  - Du vil have gratis OAuth-adgang til Qwen Coder
title: "Qwen"
x-i18n:
  source_path: providers/qwen.md
  source_hash: 88b88e224e2fecbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:32Z
---

# Qwen

Qwen tilbyder et OAuth-flow på gratis niveau for Qwen Coder- og Qwen Vision-modeller
(2.000 anmodninger/dag, underlagt Qwens hastighedsbegrænsninger).

## Aktivér plugin’et

```bash
openclaw plugins enable qwen-portal-auth
```

Genstart Gateway efter aktivering.

## Autentificering

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Dette kører Qwens OAuth device-code-flow og skriver en udbyderpost til din
`models.json` (plus et `qwen`-alias til hurtig omstilling).

## Model-id’er

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Skift model med:

```bash
openclaw models set qwen-portal/coder-model
```

## Genbrug Qwen Code CLI-login

Hvis du allerede er logget ind med Qwen Code CLI, vil OpenClaw synkronisere legitimationsoplysninger
fra `~/.qwen/oauth_creds.json`, når den indlæser auth-lageret. Du skal stadig have en
`models.providers.qwen-portal`-post (brug login-kommandoen ovenfor til at oprette en).

## Noter

- Tokens opdateres automatisk; kør login-kommandoen igen, hvis opdateringen fejler, eller adgangen tilbagekaldes.
- Standard base-URL: `https://portal.qwen.ai/v1` (kan tilsidesættes med
  `models.providers.qwen-portal.baseUrl`, hvis Qwen stiller et andet endpoint til rådighed).
- Se [Model providers](/concepts/model-providers) for udbyderfælles regler.
