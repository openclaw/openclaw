---
summary: "Manuelle logins til browserautomatisering + opslag på X/Twitter"
read_when:
  - Du skal logge ind på websites til browserautomatisering
  - Du vil poste opdateringer på X/Twitter
title: "Browser-login"
---

# Browser-login + opslag på X/Twitter

## Manuel login (anbefalet)

Når et website kræver login, skal du **logge ind manuelt** i **host**-browserprofilen (openclaw-browseren).

Giv **ikke** modellen dine legitimationsoplysninger. Automatiserede logins udløser ofte anti-bot forsvar og kan låse kontoen.

Tilbage til hoveddokumentationen for browseren: [Browser](/tools/browser).

## Hvilken Chrome-profil bruges?

OpenClaw styrer en **dedikeret Chrome-profil** (navngivet `openclaw`, orange-tonet UI). Dette er adskilt fra din daglige browserprofil.

To nemme måder at få adgang til den på:

1. **Bed agenten om at åbne browseren**, og log derefter selv ind.
2. **Åbn den via CLI**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

Hvis du har flere profiler, kan du angive `--browser-profile <name>` (standard er `openclaw`).

## X/Twitter: anbefalet flow

- **Læs/søg/tråde:** brug **host**-browseren (manuel login).
- **Post opdateringer:** brug **host**-browseren (manuel login).

## Sandboxing + adgang til host-browser

Sandboxed browser sessioner er \*\* mere sandsynlig\*\* at udløse bot detektion. For X/Twitter (og andre strenge websteder), foretrækker **vært**-browseren.

Hvis agenten er sandboxed, er browserværktøjet standard sandboks. For at tillade værtskontrol:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Ret derefter mod host-browseren:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Eller deaktiver sandboxing for den agent, der poster opdateringer.
