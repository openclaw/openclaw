---
summary: "CLI-reference for `openclaw doctor` (sundhedstjek + guidede rettelser)"
read_when:
  - Du har forbindelses-/autentificeringsproblemer og vil have guidede løsninger
  - Du har opdateret og vil lave et fornuftstjek
title: "doctor"
x-i18n:
  source_path: cli/doctor.md
  source_hash: 92310aa3f3d111e9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:59Z
---

# `openclaw doctor`

Sundhedstjek + hurtige rettelser for gateway og kanaler.

Relateret:

- Fejlfinding: [Troubleshooting](/gateway/troubleshooting)
- Sikkerhedsaudit: [Security](/gateway/security)

## Eksempler

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Noter:

- Interaktive prompts (som nøglering-/OAuth-rettelser) kører kun, når stdin er en TTY, og `--non-interactive` **ikke** er sat. Kørsler uden terminal (cron, Telegram, ingen terminal) springer prompts over.
- `--fix` (alias for `--repair`) skriver en backup til `~/.openclaw/openclaw.json.bak` og fjerner ukendte konfigurationsnøgler, hvor hver fjernelse listes.

## macOS: `launchctl` miljøoverstyringer

Hvis du tidligere kørte `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (eller `...PASSWORD`), overstyrer den værdi din konfigurationsfil og kan forårsage vedvarende “unauthorized”-fejl.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
