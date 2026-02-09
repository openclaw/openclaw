---
summary: "Log ind på GitHub Copilot fra OpenClaw ved hjælp af device flow"
read_when:
  - Du vil bruge GitHub Copilot som modeludbyder
  - Du har brug for flowet `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## Hvad er GitHub Copilot?

GitHub Copilot is GitHub's AI coding assistant. Det giver adgang til Copilot
modeller for din GitHub konto og plan. OpenClaw kan bruge Copilot som model
udbyder på to forskellige måder.

## To måder at bruge Copilot i OpenClaw

### 1. Indbygget GitHub Copilot-udbyder (`github-copilot`)

Brug det native enheds-login-flow for at få et GitHub-token, og byt det derefter for
Copilot API-tokens når OpenClaw kører. Dette er den **standard** og den enkleste sti
, fordi den ikke kræver VS-kode.

### 2. Copilot Proxy-plugin (`copilot-proxy`)

Brug **Copilot Proxy** VS Code udvidelsen som en lokal bro. OpenClaw taler til
proxyens `/v1` endpoint og bruger den model liste, du konfigurerer der. Vælg
dette når du allerede kører Copilot Proxy i VS-kode eller har brug for at køre gennem det.
Du skal aktivere plugin og holde VS Code udvidelse kørende.

Brug GitHub Copilot som modeludbyder (`github-copilot`). Login-kommandoen kører
GitHub enhedsflowet, gemmer en auth profil og opdaterer din config for at bruge den
-profil.

## CLI-opsætning

```bash
openclaw models auth login-github-copilot
```

Du bliver bedt om at besøge en URL og indtaste en engangskode. Hold terminalen
åben, indtil den er færdig.

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
