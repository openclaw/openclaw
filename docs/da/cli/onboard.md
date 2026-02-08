---
summary: "CLI-reference for `openclaw onboard` (interaktiv introduktionsguide)"
read_when:
  - Du vil have guidet opsætning af gateway, workspace, autentificering, kanaler og Skills
title: "onboard"
x-i18n:
  source_path: cli/onboard.md
  source_hash: 69a96accb2d571ff
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:56Z
---

# `openclaw onboard`

Interaktiv introduktionsguide (lokal eller fjern Gateway-opsætning).

## Relaterede vejledninger

- CLI-introduktionshub: [Onboarding Wizard (CLI)](/start/wizard)
- CLI-introduktionsreference: [CLI Onboarding Reference](/start/wizard-cli-reference)
- CLI-automatisering: [CLI Automation](/start/wizard-cli-automation)
- macOS-introduktion: [Onboarding (macOS App)](/start/onboarding)

## Eksempler

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Flow-noter:

- `quickstart`: minimale prompts, genererer automatisk et gateway-token.
- `manual`: fulde prompts for port/bind/autentificering (alias for `advanced`).
- Hurtigste første chat: `openclaw dashboard` (Control UI, ingen kanalopsætning).

## Almindelige opfølgende kommandoer

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` indebærer ikke ikke-interaktiv tilstand. Brug `--non-interactive` til scripts.
</Note>
