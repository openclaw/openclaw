---
name: clawhub
description: Use the ClawHub CLI to search, install, update, sync, and publish agent skills from clawhub.ai. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed clawhub CLI.
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["clawhub"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "clawhub",
              "bins": ["clawhub"],
              "label": "Install ClawHub CLI (npm)",
            },
          ],
      },
  }
---

# ClawHub CLI

Install

```bash
npm i -g clawhub
```

## Auth

```bash
clawhub login
clawhub whoami
clawhub logout
```

## Search

```bash
clawhub search "postgres backups"
clawhub search "calendar" --limit 5
```

## Install

```bash
clawhub install my-skill
clawhub install my-skill --version 1.2.3
clawhub install my-skill --force          # overwrite existing folder
```

## Update

Hash-based match: compares local files to registry versions, upgrades to latest unless `--version` is set.

```bash
clawhub update my-skill
clawhub update my-skill --version 1.2.3
clawhub update --all
clawhub update --all --no-input --force
```

## List

Shows installed skills from `.clawhub/lock.json`:

```bash
clawhub list
```

## Sync

Scan local skill folders, publish new or updated skills in bulk:

```bash
clawhub sync --dry-run                    # preview what would be uploaded
clawhub sync                              # interactive prompts per skill
clawhub sync --all                        # publish everything, no prompts
clawhub sync --bump minor --changelog "New features"
```

Options: `--root <dir>` (extra scan roots), `--bump patch|minor|major`, `--concurrency <n>`, `--tags <tags>`.

## Publish

Single skill publish:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.2.0 --changelog "Fixes + docs"
```

## Delete / Undelete

Owner or admin only:

```bash
clawhub delete my-skill --yes
clawhub undelete my-skill --yes
```

## Notes

- Default registry: https://clawhub.ai (override with `CLAWHUB_REGISTRY` or `--registry`)
- Default workdir: cwd (falls back to OpenClaw workspace); install dir: `./skills` (override with `--workdir` / `--dir` / `CLAWHUB_WORKDIR`)
- Installed skills tracked in `.clawhub/lock.json`; check with `clawhub list` before installing
- Use `--no-input` on any command to disable prompts for scripting and automation
