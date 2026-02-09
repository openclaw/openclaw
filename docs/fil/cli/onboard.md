---
summary: "Sanggunian ng CLI para sa `openclaw onboard` (interactive na onboarding wizard)"
read_when:
  - Gusto mo ng guided na setup para sa Gateway, workspace, auth, mga channel, at Skills
title: "onboard"
---

# `openclaw onboard`

Interactive na onboarding wizard (lokal o remote na setup ng Gateway).

## Related guides

- CLI onboarding hub: [Onboarding Wizard (CLI)](/start/wizard)
- Sanggunian ng CLI onboarding: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Automation ng CLI: [CLI Automation](/start/wizard-cli-automation)
- macOS onboarding: [Onboarding (macOS App)](/start/onboarding)

## Mga halimbawa

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Mga tala sa flow:

- `quickstart`: minimal na mga prompt, awtomatikong bumubuo ng gateway token.
- `manual`: kumpletong mga prompt para sa port/bind/auth (alias ng `advanced`).
- Pinakamabilis na unang chat: `openclaw dashboard` (Control UI, walang setup ng channel).

## Mga karaniwang follow-up na command

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
Ang `--json` ay hindi nangangahulugang non-interactive mode. Gamitin ang `--non-interactive` para sa mga script.
</Note>
