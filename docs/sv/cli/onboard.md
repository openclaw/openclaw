---
summary: "CLI-referens för `openclaw onboard` (interaktiv introduktionsguide)"
read_when:
  - Du vill ha guidad konfigurering för gateway, arbetsyta, autentisering, kanaler och Skills
title: "onboard"
x-i18n:
  source_path: cli/onboard.md
  source_hash: 69a96accb2d571ff
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:47Z
---

# `openclaw onboard`

Interaktiv introduktionsguide (lokal eller fjärr-Gateway-konfigurering).

## Relaterad dokumentation

- CLI-introduktionsnav: [Introduktionsguide (CLI)](/start/wizard)
- CLI-introduktionsreferens: [CLI Introduktionsreferens](/start/wizard-cli-reference)
- CLI-automatisering: [CLI Automation](/start/wizard-cli-automation)
- macOS-introduktion: [Introduktion (macOS-app)](/start/onboarding)

## Exempel

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Flödesanteckningar:

- `quickstart`: minimala uppmaningar, genererar automatiskt en gateway-token.
- `manual`: fullständiga uppmaningar för port/bind/autentisering (alias till `advanced`).
- Snabbaste första chatten: `openclaw dashboard` (Control UI, ingen kanalinställning).

## Vanliga uppföljande kommandon

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` innebär inte icke-interaktivt läge. Använd `--non-interactive` för skript.
</Note>
