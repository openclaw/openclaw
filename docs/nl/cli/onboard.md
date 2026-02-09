---
summary: "CLI-referentie voor `openclaw onboard` (interactieve onboardingwizard)"
read_when:
  - Je wilt begeleide installatie voor Gateway, werkruimte, authenticatie, kanalen en Skills
title: "onboard"
---

# `openclaw onboard`

Interactieve onboardingwizard (lokale of externe Gateway-installatie).

## Gerelateerde gidsen

- CLI-onboardinghub: [Onboarding Wizard (CLI)](/start/wizard)
- CLI-onboardingreferentie: [CLI Onboarding Reference](/start/wizard-cli-reference)
- CLI-automatisering: [CLI Automation](/start/wizard-cli-automation)
- macOS-onboarding: [Onboarding (macOS App)](/start/onboarding)

## Voorbeelden

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Flow-notities:

- `quickstart`: minimale prompts, genereert automatisch een gateway-token.
- `manual`: volledige prompts voor poort/binding/auth (alias van `advanced`).
- Snelste eerste chat: `openclaw dashboard` (Control UI, geen kanaalconfiguratie).

## Gemeenschappelijke follow-upopdrachten

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` impliceert geen niet-interactieve modus. Gebruik `--non-interactive` voor scripts.
</Note>
