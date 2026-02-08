---
summary: "CLI-referentie voor `openclaw doctor` (gezondheidscontroles + begeleide reparaties)"
read_when:
  - Je hebt verbindings-/authenticatieproblemen en wilt begeleide oplossingen
  - Je hebt geüpdatet en wilt een sanitycheck
title: "doctor"
x-i18n:
  source_path: cli/doctor.md
  source_hash: 92310aa3f3d111e9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:12Z
---

# `openclaw doctor`

Gezondheidscontroles + snelle fixes voor de Gateway en kanalen.

Gerelateerd:

- Problemen oplossen: [Troubleshooting](/gateway/troubleshooting)
- Beveiligingsaudit: [Security](/gateway/security)

## Voorbeelden

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Notities:

- Interactieve prompts (zoals keychain-/OAuth-fixes) worden alleen uitgevoerd wanneer stdin een TTY is en `--non-interactive` **niet** is ingesteld. Headless-uitvoeringen (cron, Telegram, geen terminal) slaan prompts over.
- `--fix` (alias voor `--repair`) schrijft een back-up naar `~/.openclaw/openclaw.json.bak` en verwijdert onbekende config-sleutels, waarbij elke verwijdering wordt opgesomd.

## macOS: `launchctl` omgevingsvariabele-overschrijvingen

Als je eerder `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (of `...PASSWORD`) hebt uitgevoerd, overschrijft die waarde je configbestand en kan dit aanhoudende “unauthorized”-fouten veroorzaken.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
