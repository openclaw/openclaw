---
summary: "CLI reference for `openclaw setup`, an alias for `openclaw onboard`"
read_when:
  - You want to use `openclaw setup` for first-run onboarding
  - You need to understand setup compatibility behavior
title: "Setup"
---

# `openclaw setup`

`openclaw setup` is an alias for [`openclaw onboard`](/cli/onboard). It accepts
the same flags and runs the same minimal-first onboarding flow.

<Note>
`openclaw setup` is for mutable config installs. In Nix mode (`OPENCLAW_NIX_MODE=1`) OpenClaw refuses setup writes because the config file is managed by Nix. Use the first-party [nix-openclaw Quick Start](https://github.com/openclaw/nix-openclaw#quick-start) or the equivalent source config for another Nix package.
</Note>

`--wizard` remains accepted for compatibility and selects the advanced flow.
See [`openclaw onboard`](/cli/onboard) for the full option reference.

`--skip-ui` by itself, optionally with `--workspace`, preserves the baseline
setup path for source checkouts and scripts. It prepares config, workspace,
sessions, and `gateway.mode` without writing quickstart Gateway defaults. Add
another explicit onboarding flag to run onboarding without opening the final
local agent.

## Examples

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
openclaw setup --flow advanced
openclaw setup --import-from hermes --import-source ~/.hermes
openclaw setup --non-interactive --accept-risk --mode remote --remote-url wss://gateway-host:18789 --remote-token <token>
```

## Notes

- Plain `openclaw setup` runs the same minimal flow as `openclaw onboard`.
- Use `--flow advanced` or explicit Gateway/daemon flags for the full infrastructure wizard.
- Use `--skip-ui` when a script or source-checkout workflow should finish without opening the local agent.
- If Hermes state is detected, interactive onboarding can offer migration automatically. Import onboarding requires a fresh setup; use [Migrate](/cli/migrate) for dry-run plans, backups, and overwrite mode outside onboarding.

## Related

- [CLI reference](/cli)
- [Onboarding (CLI)](/start/wizard)
- [Getting started](/start/getting-started)
- [Install overview](/install)
