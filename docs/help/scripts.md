---
summary: "Repository scripts: purpose, scope, and safety notes"
read_when:
  - Running scripts from the repo
  - Adding or changing scripts under ./scripts
title: "Scripts"
---

The `scripts/` directory contains helper scripts for local workflows and ops tasks.
Use these when a task is clearly tied to a script; otherwise prefer the CLI.

## Conventions

- Scripts are **optional** unless referenced in docs or release checklists.
- Prefer CLI surfaces when they exist (example: auth monitoring uses `openclaw models status --check`).
- Assume scripts are host‑specific; read them before running on a new machine.

## Auth monitoring scripts

Auth monitoring is covered in [Authentication](/gateway/authentication). The scripts under `scripts/` are optional extras for systemd/Termux phone workflows.

## GitHub read helper

Use `scripts/gh-read` when you want `gh` to use a GitHub App installation token for repo-scoped read calls while leaving normal `gh` on your personal login for write actions.

Required env:

- `OPENCLAW_GH_READ_APP_ID`
- `OPENCLAW_GH_READ_PRIVATE_KEY_FILE`

Optional env:

- `OPENCLAW_GH_READ_INSTALLATION_ID` when you want to skip repo-based installation lookup
- `OPENCLAW_GH_READ_PERMISSIONS` as a comma-separated override for the read permission subset to request

Repo resolution order:

- `gh ... -R owner/repo`
- `GH_REPO`
- `GITHUB_REPOSITORY`
- `git remote origin`

Examples:

- `scripts/gh-read pr view 123`
- `scripts/gh-read run list -R openclaw/openclaw`
- `scripts/gh-read api repos/openclaw/openclaw/pulls/123`

## GitHub App token helper

Use `scripts/openclaw-gh-token` when a container or runtime script needs a raw GitHub App installation token. Repo context is preferred because it lets GitHub choose the correct App installation:

- `scripts/openclaw-gh-token --repo Outta-Bounds/openclaw-workspace-engineering`
- `GH_REPO=sebbyyyywebbyyy/example scripts/openclaw-gh-token --probe`

Agents can also force a known installation when repo context is unavailable:

- `scripts/openclaw-gh-token --installation outta --probe`
- `scripts/openclaw-gh-token --installation personal --probe`
- `eval "$(scripts/openclaw-gh-token --installation outta --export)"`

Installation aliases:

- `outta`, `primary`, `openclaw`, `agents`: Outta-Bounds/OpenClaw repos.
- `personal`, `secondary`, `sebbyyyywebbyyy`: personal repos.

When repo context is present and no installation alias is forced, it asks GitHub for the App installation attached to that repository before minting the token. A forced installation alias only scopes to explicit repo context (`--repo`, `GH_REPO`, or `GITHUB_REPOSITORY`), so the current directory's git remote cannot accidentally mix installations. Without repo context, it falls back to the primary Outta-Bounds/OpenClaw installation.

## When adding scripts

- Keep scripts focused and documented.
- Add a short entry in the relevant doc (or create one if missing).

## Related

- [Testing](/help/testing)
- [Testing live](/help/testing-live)
