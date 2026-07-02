---
summary: "CLI reference for `openclaw setup` (alias for onboarding, with baseline setup available by flag)"
read_when:
  - You're doing first-run setup with the CLI onboarding wizard
  - You want to set the default workspace path
  - You need the baseline-only setup flag for scripts
title: "Setup"
---

# `openclaw setup`

Run the full CLI onboarding flow. `openclaw setup` is an alias for `openclaw onboard`; use `--baseline` when you only need to initialize config/workspace folders without the wizard.

<Note>
`openclaw setup` is for mutable config installs. In Nix mode (`OPENCLAW_NIX_MODE=1`) OpenClaw refuses setup writes because the config file is managed by Nix. Use the first-party [nix-openclaw Quick Start](https://github.com/openclaw/nix-openclaw#quick-start) or the equivalent source config for another Nix package.
</Note>

## Options

| Flag                       | Description                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `--workspace <dir>`        | Agent workspace directory (default `~/.openclaw/workspace`; stored as `agents.defaults.workspace`). |
| `--baseline`               | Create baseline config/workspace/session folders without onboarding.                                |
| `--wizard`                 | Accepted for compatibility; setup runs onboarding by default.                                       |
| `--non-interactive`        | Run onboarding without prompts.                                                                     |
| `--accept-risk`            | Acknowledge full-system agent access risk; required with `--non-interactive`.                       |
| `--mode <mode>`            | Onboarding mode: `local` or `remote`.                                                               |
| `--import-from <provider>` | Migration provider to run during onboarding.                                                        |
| `--import-source <path>`   | Source agent home for `--import-from`.                                                              |
| `--import-secrets`         | Import supported secrets during onboarding migration.                                               |
| `--remote-url <url>`       | Remote Gateway WebSocket URL.                                                                       |
| `--remote-token <token>`   | Remote Gateway token (optional).                                                                    |

### Baseline mode

`openclaw setup --baseline` preserves the older baseline-only behavior: it creates the config, workspace, and session directories, then exits without running onboarding.

## Examples

```bash
openclaw setup
openclaw setup --baseline
openclaw setup --workspace ~/.openclaw/workspace
openclaw setup --import-from hermes --import-source ~/.hermes
openclaw setup --non-interactive --accept-risk --mode remote --remote-url wss://gateway-host:18789 --remote-token <token>
```

## Notes

- Plain `openclaw setup` runs the same guided journey as `openclaw onboard`.
- After baseline setup, run `openclaw setup` or `openclaw onboard` for the full guided journey, `openclaw configure` for targeted changes, or `openclaw channels add` to add channel accounts.
- If Hermes state is detected, interactive onboarding can offer migration automatically. Import onboarding requires a fresh setup; use [Migrate](/cli/migrate) for dry-run plans, backups, and overwrite mode outside onboarding.

## Related

- [CLI reference](/cli)
- [Onboarding (CLI)](/start/wizard)
- [Getting started](/start/getting-started)
- [Install overview](/install)
