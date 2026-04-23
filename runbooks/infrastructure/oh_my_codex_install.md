---
doc_id: rbk_oh_my_codex_install
title: Install or refresh oh-my-codex via pipx
type: ops_sop
lifecycle_state: draft
owners:
  primary: platform
tags: ["tools", "codex", "pipx", "oh-my-codex"]
aliases: ["omx install", "oh-my-codex pipx install"]
scope:
  service: "Codex agent tooling"
  feature: "local helper CLI distribution"
  plugin: ""
  environments: ["operator-desktop"]
validation:
  last_validated_at: "2026-04-08"
  review_interval_days: 30
provenance:
  source_type: human
  source_ref: "local install run 2026-04-08"
retrieval:
  synopsis: "How to install the oh-my-codex CLI from the [full] extras package using pipx on Debian/Ubuntu hosts without touching the system python."
  hints:
    [
      "Use `pipx ensurepath` or manually add `~/.local/bin` to PATH",
      "pipx already installs shared libs; rerun install if they are missing",
    ]
  not_for: ["system python packages managed through apt"]
  commands:
    [
      "sudo apt-get install -y pipx python3-venv python3-wheel",
      "pipx install oh-my-codex[full]",
      "pipx ensurepath",
    ]
---

# Purpose

Record the repeatable steps that prepare a Debian/Ubuntu workstation so that `omx`/`omx-setup` from `oh-my-codex[full]` can run without breaking the system python.

# Aliases

- `omx install`
- `oh-my-codex pipx install`
- `install omx tooling`

# When to use

- Setting up or refreshing the Codex helper toolchain on a new desktop/laptop.
- Recovering when `omx` or `omx-setup` is missing after a clean image or PATH change.
- Deploying tooling upgrades that require the `[full]` extras set of oh-my-codex.

# Prerequisites

- Debian/Ubuntu host with working `sudo` privileges.
- Python 3.12 (or newer) provided by the system binary; do not modify the system `pip`.
- Network connectivity to download packages from PyPI.
- `pipx` package manager installed (see mitigation below if it is not).

# Signals / symptoms

- `command not found: omx` or `omx` invokes an older install in `/usr/bin`.
- `python3 -m pip install oh-my-codex[full]` fails with `externally-managed-environment` (PEP 668) errors.
- `pipx` itself is missing or reports `pipx: command not found`.
- `~/.local/bin/omx` exists but shells cannot find it because the directory is absent from `PATH`.

# Triage

1. Confirm the failure mode by running `which omx` and `python3 -m pip install oh-my-codex[full]` to see PEP 668 hints.
2. Check for pipx availability with `command -v pipx`; if it is missing, install via `sudo apt-get install -y pipx python3-venv python3-wheel`.
3. Ensure `~/.local/bin` is not already in `PATH`; if it is missing, the client warnings after pipx install explain how to run `pipx ensurepath` or edit `~/.bashrc`.

# Mitigation

1. Install pipx and its runtime dependencies via apt so Debian keeps Python system packages isolated:

   ```bash
   sudo apt-get update
   sudo apt-get install -y pipx python3-venv python3-wheel
   ```

2. Use pipx to install `oh-my-codex[full]`. This creates a dedicated virtual environment and avoids overwriting system packages:

   ```bash
   pipx install oh-my-codex[full]
   ```

   If the command prints warnings about `~/.local/bin`, run `pipx ensurepath` and open a new shell so `omx` becomes reachable.

3. If pipx reports that `omx` already exists elsewhere (e.g., `/usr/local/bin`), allow it to replace by confirming the install, but keep `~/.local/bin` prioritized in PATH.

4. Document the install in your local runbook or README so future operators know that `omx` was installed via pipx and that `~/.local/bin` must be on PATH.

# Validation

- `command -v omx` should point to `$HOME/.local/bin/omx` (or wherever pipx keeps shared binaries).
- `omx --version` or `omx help` should exit cleanly and list the help text.
- Running `pipx list` should show `oh-my-codex` installed with its dependency tree.

# Rollback

1. Review `pipx list` to confirm the exact package alias, then run:

   ```bash
   pipx uninstall oh-my-codex
   ```

2. If you no longer need pipx, remove it with `sudo apt-get remove --purge pipx python3-venv python3-wheel` and restore any PATH edits.

# Related runbooks

- None yet; consider referencing `runbooks/templates/runbook_template.md` when creating follow-on docs.

# Change history

- 2026-04-08: Created new runbook describing the pipx-based installation of oh-my-codex[full].
- 2026-04-13: Normalized the runbook type to `ops_sop` so the live runbook-memory validator accepts the doc.
