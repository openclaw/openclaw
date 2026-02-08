---
summary: "Manuelle logins til browserautomatisering + opslag på X/Twitter"
read_when:
  - Du skal logge ind på websites til browserautomatisering
  - Du vil poste opdateringer på X/Twitter
title: "Browser-login"
x-i18n:
  source_path: tools/browser-login.md
  source_hash: c30faa9da6c6ef70
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:39Z
---

# Browser-login + opslag på X/Twitter

## Manuel login (anbefalet)

Når et website kræver login, skal du **logge ind manuelt** i **host**-browserprofilen (openclaw-browseren).

Giv **ikke** modellen dine loginoplysninger. Automatiserede logins udløser ofte anti‑bot‑forsvar og kan låse kontoen.

Tilbage til hoveddokumentationen for browseren: [Browser](/tools/browser).

## Hvilken Chrome-profil bruges?

OpenClaw styrer en **dedikeret Chrome-profil** (navngivet `openclaw`, orangefarvet UI). Den er adskilt fra din daglige browserprofil.

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

Sandboxede browsersessioner er **mere tilbøjelige** til at udløse bot-detektion. For X/Twitter (og andre strikse websites) bør du foretrække **host**-browseren.

Hvis agenten er sandboxet, bruger browser-værktøjet som standard sandboxen. For at tillade host-kontrol:

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
