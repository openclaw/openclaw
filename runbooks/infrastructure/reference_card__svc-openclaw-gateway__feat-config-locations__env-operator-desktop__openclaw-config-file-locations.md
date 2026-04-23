---
doc_id: rbk_openclaw_gateway_config_locations
title: OpenClaw config file locations
type: reference_card
lifecycle_state: active
owners:
  primary: platform
tags:
  - config
  - paths
  - gateway
  - workspace
  - staging
  - operator-desktop
aliases:
  - config.toml
  - tomel.config
  - openclaw.json
  - openclaw.env
  - local-first-routing.json
  - workspace AGENTS.md
  - openclaw gateway config
scope:
  service: openclaw-gateway
  feature: config-locations
  plugin: ""
  environments:
    - operator-desktop
validation:
  last_validated_at: "2026-04-22"
  review_interval_days: 30
provenance:
  source_type: human_or_agent
  source_ref: openclaw-safe-install README, operator checklist, staging apply script, and agent-workspace docs
retrieval:
  synopsis: Path map for live OpenClaw config, env overrides, local-first policy, and workspace AGENTS.md.
  hints:
    - config.toml
    - tomel.config
    - openclaw.json
    - openclaw.env
    - local-first-routing.json
    - workspace AGENTS.md
    - live path
    - staging path
    - openclaw-gateway.service
  not_for:
    - ~/.codex/config.toml
    - general toml config files
    - model-provider setup docs
  commands:
    - sudo sed -n '1,220p' /var/lib/openclaw/.openclaw/openclaw.json
    - sudo sed -n '1,180p' /var/lib/openclaw/.openclaw/openclaw.env
    - sudo sed -n '1,220p' /var/lib/openclaw/.openclaw/policies/local-first-routing.json
    - sed -n '1,220p' /home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.json
    - sed -n '1,180p' /home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.env
    - sed -n '1,220p' /home/ebatter1/Documents/openclaw-safe-install/staging/local-first-routing-policy.json
    - sed -n '1,220p' /home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.service
---

# Purpose

Keep the host-side OpenClaw config tree, the staged source files, and the workspace agent doc easy to find without guessing between live and staging copies.

# Aliases

- `config.toml`
- `tomel.config`
- `openclaw.json`
- `openclaw.env`
- `local-first-routing.json`
- `workspace AGENTS.md`
- `config locations`

# When to use

- A query asks where the OpenClaw config lives on this host.
- Someone wants the live config path instead of the staged source tree.
- A question mentions `config.toml` or `tomel.config` but is really about OpenClaw config files.
- You need the path for the gateway token, environment overrides, local-first policy, or workspace instructions.

# Prerequisites

- Read access to `/var/lib/openclaw/.openclaw/` and `/home/ebatter1/Documents/openclaw-safe-install/`.
- `sudo` for the live files under `/var/lib/openclaw/.openclaw/`.
- Awareness that the live runtime uses the `openclaw-gateway.service` user unit, not the staged host unit file.

# Signals / symptoms

- The operator asks for "the config" but does not name a file.
- The operator asks for a TOML config path, but the real target is the OpenClaw JSON config tree.
- The operator needs to know which copy is live and which copy is the staged source.
- The staging policy source is named `local-first-routing-policy.json`, while the installed live policy is `local-first-routing.json`.
- The workspace instruction file is being confused with the service config tree.

# Triage

Use this path map first.

| Item                | Live path                                                       | Staging / source path                                                                               | Notes                                                                                                |
| ------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Gateway config      | `/var/lib/openclaw/.openclaw/openclaw.json`                     | `/home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.json`                              | Live file is the authority for token, bind mode, plugin wiring, and model routing.                   |
| Runtime env         | `/var/lib/openclaw/.openclaw/openclaw.env`                      | `/home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.env`                               | Loaded by the service unit as `EnvironmentFile` when present.                                        |
| Local-first policy  | `/var/lib/openclaw/.openclaw/policies/local-first-routing.json` | `/home/ebatter1/Documents/openclaw-safe-install/staging/local-first-routing-policy.json`            | Source filename differs from the installed filename.                                                 |
| Workspace agent doc | `/home/ebatter1/.openclaw/workspace/AGENTS.md`                  | `/home/ebatter1/Documents/openclaw-safe-install/staging/runbook_memory/reports/bootstrap_report.md` | There is no staged copy of the workspace file; the bootstrap report records the live workspace path. |

The live gateway config tree is under `/var/lib/openclaw/.openclaw/`. The staged tree under `Documents/openclaw-safe-install/staging/` is the source pack used to refresh live state.

# Validation

Confirm the live files first:

```bash
sudo sed -n '1,220p' /var/lib/openclaw/.openclaw/openclaw.json
sudo sed -n '1,180p' /var/lib/openclaw/.openclaw/openclaw.env
sudo sed -n '1,220p' /var/lib/openclaw/.openclaw/policies/local-first-routing.json
sed -n '1,220p' /home/ebatter1/.openclaw/workspace/AGENTS.md
```

Then confirm the staged source copies:

```bash
sed -n '1,220p' /home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.json
sed -n '1,180p' /home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.env
sed -n '1,220p' /home/ebatter1/Documents/openclaw-safe-install/staging/local-first-routing-policy.json
sed -n '1,220p' /home/ebatter1/Documents/openclaw-safe-install/staging/openclaw.service
```

If the question is "which config is live?", treat `/var/lib/openclaw/.openclaw/openclaw.json` and `/var/lib/openclaw/.openclaw/openclaw.env` as authoritative for the running gateway, and treat `Documents/openclaw-safe-install/staging/` as the editable source pack.

# Related runbooks

- `/home/ebatter1/Documents/openclaw-safe-install/README.md`
- `/home/ebatter1/Documents/openclaw-safe-install/OPERATOR-CHECKLIST.md`
- `/home/ebatter1/openclaw-upstream/docs/concepts/agent-workspace.md`

# Change history

- 2026-04-22: Added the live vs staging path map for `openclaw.json`, `openclaw.env`, `local-first-routing.json`, and `AGENTS.md`, plus search aliases for `config.toml` and `tomel.config`.
