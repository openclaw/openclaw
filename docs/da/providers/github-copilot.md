---
summary: "Log ind på GitHub Copilot fra OpenClaw ved hjælp af device flow"
read_when:
  - Du vil bruge GitHub Copilot som modeludbyder
  - Du har brug for flowet `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
x-i18n:
  source_path: providers/github-copilot.md
  source_hash: 503e0496d92c921e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:30Z
---

# GitHub Copilot

## Hvad er GitHub Copilot?

GitHub Copilot er GitHubs AI-kodeassistent. Den giver adgang til Copilot-modeller
for din GitHub-konto og dit abonnement. OpenClaw kan bruge Copilot som
modeludbyder på to forskellige måder.

## To måder at bruge Copilot i OpenClaw

### 1) Indbygget GitHub Copilot-udbyder (`github-copilot`)

Brug det indbyggede device-login-flow til at hente et GitHub-token, og udskift
det derefter med Copilot API-tokens, når OpenClaw kører. Dette er **standard**
og den enkleste løsning, fordi den ikke kræver VS Code.

### 2) Copilot Proxy-plugin (`copilot-proxy`)

Brug **Copilot Proxy** VS Code-udvidelsen som en lokal bro. OpenClaw taler med
proxyens `/v1`-endpoint og bruger den modelliste, du konfigurerer der.
Vælg dette, hvis du allerede kører Copilot Proxy i VS Code eller har brug for at
route gennem den. Du skal aktivere pluginet og holde VS Code-udvidelsen kørende.

Brug GitHub Copilot som modeludbyder (`github-copilot`). Login-kommandoen kører
GitHubs device flow, gemmer en auth-profil og opdaterer din konfiguration til at
bruge den profil.

## CLI-opsætning

```bash
openclaw models auth login-github-copilot
```

Du bliver bedt om at besøge en URL og indtaste en engangskode. Hold terminalen
åben, indtil det er fuldført.

### Valgfrie flag

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Indstil en standardmodel

```bash
openclaw models set github-copilot/gpt-4o
```

### Konfigurationsudsnit

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Noter

- Kræver en interaktiv TTY; kør den direkte i en terminal.
- Tilgængeligheden af Copilot-modeller afhænger af dit abonnement; hvis en model
  bliver afvist, så prøv et andet ID (for eksempel `github-copilot/gpt-4.1`).
- Login gemmer et GitHub-token i auth-profillageret og udskifter det med et
  Copilot API-token, når OpenClaw kører.
