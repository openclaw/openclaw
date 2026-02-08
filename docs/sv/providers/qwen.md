---
summary: "Använd Qwen OAuth (gratisnivå) i OpenClaw"
read_when:
  - Du vill använda Qwen med OpenClaw
  - Du vill ha OAuth-åtkomst på gratisnivå till Qwen Coder
title: "Qwen"
x-i18n:
  source_path: providers/qwen.md
  source_hash: 88b88e224e2fecbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:12Z
---

# Qwen

Qwen tillhandahåller ett OAuth-flöde på gratisnivå för modellerna Qwen Coder och Qwen Vision
(2 000 förfrågningar/dag, med förbehåll för Qwens hastighetsbegränsningar).

## Aktivera pluginet

```bash
openclaw plugins enable qwen-portal-auth
```

Starta om Gateway efter aktivering.

## Autentisering

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Detta kör Qwens OAuth-flöde med enhetskod och skriver en leverantörspost till din
`models.json` (plus ett `qwen`-alias för snabb växling).

## Modell-ID:n

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Växla modeller med:

```bash
openclaw models set qwen-portal/coder-model
```

## Återanvänd inloggning från Qwen Code CLI

Om du redan har loggat in med Qwen Code CLI kommer OpenClaw att synkronisera autentiseringsuppgifter
från `~/.qwen/oauth_creds.json` när autentiseringslagret läses in. Du behöver fortfarande en
`models.providers.qwen-portal`-post (använd inloggningskommandot ovan för att skapa en).

## Noteringar

- Token uppdateras automatiskt; kör inloggningskommandot igen om uppdateringen misslyckas eller åtkomsten återkallas.
- Standard-bas-URL: `https://portal.qwen.ai/v1` (åsidosätt med
  `models.providers.qwen-portal.baseUrl` om Qwen tillhandahåller en annan slutpunkt).
- Se [Model providers](/concepts/model-providers) för leverantörsövergripande regler.
