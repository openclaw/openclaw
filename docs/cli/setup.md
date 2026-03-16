---
summary: "CLI reference for `openclaw setup` (initialize config/workspace or run the setup wizard)"
read_when:
  - You want first-run setup without the guided wizard
  - You want the guided setup wizard via `openclaw setup --wizard`
  - You want to set the default workspace path
title: "setup"
---

# `openclaw setup`

Initialize `~/.openclaw/openclaw.json` and the agent workspace, or run the guided setup wizard.

Related:

- Getting started: [Getting started](/start/getting-started)
- Setup wizard: [Setup Wizard (CLI)](/start/wizard)
- macOS app onboarding: [Onboarding](/start/onboarding)

## Examples

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
openclaw setup --wizard
openclaw setup --wizard --install-daemon
```

Without flags, `openclaw setup` only ensures config + workspace defaults.
Use `--wizard` for the full guided flow.

## Modes

- `openclaw setup`: initialize config/workspace defaults only
- `openclaw setup --wizard`: guided setup for auth, gateway, channels, and skills
- `openclaw setup --wizard --non-interactive`: scripted setup flow

## Related guides

- Setup wizard guide: [Setup Wizard (CLI)](/start/wizard)
- Setup wizard reference: [CLI Setup Reference](/start/wizard-cli-reference)
- Setup wizard automation: [CLI Automation](/start/wizard-cli-automation)
- Legacy alias: [`openclaw onboard`](/cli/onboard)
