---
title: "Vercel AI Gateway"
summary: "Einrichtung des Vercel AI Gateway (Authentifizierung + Modellauswahl)"
read_when:
  - Sie möchten Vercel AI Gateway mit OpenClaw verwenden
  - Sie benötigen die API-Schlüssel-Umgebungsvariable oder die CLI-Authentifizierungsoption
---

# Vercel AI Gateway

Das [Vercel AI Gateway](https://vercel.com/ai-gateway) stellt eine einheitliche API bereit, um über einen einzigen Endpunkt auf Hunderte von Modellen zuzugreifen.

- Anbieter: `vercel-ai-gateway`
- Authentifizierung: `AI_GATEWAY_API_KEY`
- API: Kompatibel mit Anthropic Messages

## Schnellstart

1. Legen Sie den API-Schlüssel fest (empfohlen: für das Gateway speichern):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Legen Sie ein Standardmodell fest:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Nicht-interaktives Beispiel

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Umgebungshinweis

Wenn das Gateway als Daemon (launchd/systemd) ausgeführt wird, stellen Sie sicher, dass `AI_GATEWAY_API_KEY`
diesem Prozess zur Verfügung steht (zum Beispiel in `~/.openclaw/.env` oder über
`env.shellEnv`).
