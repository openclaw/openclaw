---
summary: "Sanggunian ng CLI para sa `openclaw doctor` (mga health check + ginabayang pag-aayos)"
read_when:
  - Mayroon kang mga isyu sa connectivity/auth at gusto mo ng ginabayang mga ayos
  - Nag-update ka at gusto mo ng sanity check
title: "doctor"
x-i18n:
  source_path: cli/doctor.md
  source_hash: 92310aa3f3d111e9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:20Z
---

# `openclaw doctor`

Mga health check + mabilisang ayos para sa Gateway at mga channel.

Kaugnay:

- Pag-troubleshoot: [Troubleshooting](/gateway/troubleshooting)
- Audit sa seguridad: [Security](/gateway/security)

## Mga halimbawa

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Mga tala:

- Ang mga interactive prompt (gaya ng keychain/OAuth fixes) ay tumatakbo lamang kapag ang stdin ay isang TTY at **hindi** naka-set ang `--non-interactive`. Ang mga headless run (cron, Telegram, walang terminal) ay lalaktawan ang mga prompt.
- Ang `--fix` (alias para sa `--repair`) ay nagsusulat ng backup sa `~/.openclaw/openclaw.json.bak` at inaalis ang mga hindi kilalang config key, na inililista ang bawat tinanggal.

## macOS: `launchctl` env overrides

Kung dati mong pinatakbo ang `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (o `...PASSWORD`), ina-override ng value na iyon ang iyong config file at maaaring magdulot ng paulit-ulit na “unauthorized” na mga error.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
