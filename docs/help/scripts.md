---
summary: "Repository scripts: purpose, scope, and safety notes"
read_when:
  - Running scripts from the repo
  - Adding or changing scripts under ./scripts
title: "Scripts"
---

# Scripts

The `scripts/` directory contains helper scripts for local workflows and ops tasks.
Use these when a task is clearly tied to a script; otherwise prefer the CLI.

## Conventions

- Scripts are **optional** unless referenced in docs or release checklists.
- Prefer CLI surfaces when they exist (example: auth monitoring uses `openclaw models status --check`).
- Assume scripts are host‑specific; read them before running on a new machine.

## Auth monitoring scripts

Auth monitoring scripts are documented here:
[/automation/auth-monitoring](/automation/auth-monitoring)

## PR workflow scripts

Use `scripts/pr` for structured review/prepare/merge flows when maintaining PRs:

- `scripts/pr review-init <PR>`
- `scripts/pr prepare-run <PR>`
- `scripts/pr merge-verify <PR>`

Before opening a new PR, complete the repository PR template in `.github/pull_request_template.md` and include reproducible verification evidence.

## When adding scripts

- Keep scripts focused and documented.
- Add a short entry in the relevant doc (or create one if missing).
