---
summary: "Använd Qwen OAuth (gratisnivå) i OpenClaw"
read_when:
  - Du vill använda Qwen med OpenClaw
  - Du vill ha OAuth-åtkomst på gratisnivå till Qwen Coder
title: "Qwen"
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

Om du redan är inloggad med Qwen Code CLI, kommer OpenClaw att synkronisera autentiseringsuppgifter
från `~/.qwen/oauth_creds.json` när den laddar auth butiken. Du behöver fortfarande en
`models.providers.qwen-portal` post (använd inloggningskommandot ovan för att skapa en).

## Noteringar

- Token uppdateras automatiskt; kör inloggningskommandot igen om uppdateringen misslyckas eller åtkomsten återkallas.
- Standard-bas-URL: `https://portal.qwen.ai/v1` (åsidosätt med
  `models.providers.qwen-portal.baseUrl` om Qwen tillhandahåller en annan slutpunkt).
- Se [Model providers](/concepts/model-providers) för leverantörsövergripande regler.
