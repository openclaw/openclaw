---
summary: "Referencja CLI dla `openclaw onboard` (interaktywny kreator wdrażania)"
read_when:
  - Chcesz przejść przez konfigurację z przewodnikiem dla Gateway, obszaru roboczego, uwierzytelniania, kanałów i Skills
title: "onboard"
x-i18n:
  source_path: cli/onboard.md
  source_hash: 69a96accb2d571ff
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:57Z
---

# `openclaw onboard`

Interaktywny kreator wdrażania (lokalna lub zdalna konfiguracja Gateway).

## Related guides

- Centrum wdrażania CLI: [Onboarding Wizard (CLI)](/start/wizard)
- Referencja wdrażania CLI: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Automatyzacja CLI: [CLI Automation](/start/wizard-cli-automation)
- Wdrażanie na macOS: [Onboarding (macOS App)](/start/onboarding)

## Examples

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Flow notes:

- `quickstart`: minimalne monity, automatycznie generuje token gateway.
- `manual`: pełne monity dla portu/bindowania/uwierzytelniania (alias `advanced`).
- Najszybszy pierwszy czat: `openclaw dashboard` (UI sterujące, bez konfiguracji kanałów).

## Common follow-up commands

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` nie oznacza trybu nieinteraktywnego. Do skryptów użyj `--non-interactive`.
</Note>
