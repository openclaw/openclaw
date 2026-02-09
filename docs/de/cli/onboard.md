---
summary: "CLI-Referenz für `openclaw onboard` (interaktiver Onboarding-Assistent)"
read_when:
  - Sie möchten eine geführte Einrichtung für Gateway, Workspace, Authentifizierung, Kanäle und Skills
title: "onboard"
---

# `openclaw onboard`

Interaktiver Onboarding-Assistent (lokale oder entfernte Gateway-Einrichtung).

## Zugehörige Anleitungen

- CLI-Onboarding-Hub: [Onboarding Wizard (CLI)](/start/wizard)
- CLI-Onboarding-Referenz: [CLI Onboarding Reference](/start/wizard-cli-reference)
- CLI-Automatisierung: [CLI Automation](/start/wizard-cli-automation)
- macOS-Onboarding: [Onboarding (macOS App)](/start/onboarding)

## Beispiele

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Flow Notizen:

- `quickstart`: minimale Abfragen, generiert automatisch ein Gateway-Token.
- `manual`: vollständige Abfragen für Port/Bind/Auth (Alias von `advanced`).
- Schnellster erster Chat: `openclaw dashboard` (Control-UI, keine Kanaleinrichtung).

## Häufige Folgekommandos

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` impliziert keinen nicht-interaktiven Modus. Verwenden Sie `--non-interactive` für Skripte.
</Note>
