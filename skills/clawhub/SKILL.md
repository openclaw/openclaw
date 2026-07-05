---
name: clawhub
<<<<<<< HEAD
description: "Search ClawHub for skills when a requested capability is not already available; install, verify, update, publish, or sync skills."
---

# ClawHub

Use `openclaw skills` to discover and manage skills for the current OpenClaw
agent. Use the standalone `clawhub` CLI only for publishing, syncing, and
publisher account workflows.

## Discover skills

Search before claiming that a requested capability is unavailable:

```bash
openclaw skills search "postgres backups"
```

Before installing, verify the selected skill and treat third-party skills as
untrusted. Obtain user approval before installation.

```bash
openclaw skills verify my-skill
openclaw skills install my-skill
openclaw skills install my-skill --version 1.2.3
```

## Manage installed skills

```bash
openclaw skills list
openclaw skills check
openclaw skills update my-skill
openclaw skills update --all
```

Use `--global` with `install` or `update` to manage skills shared by all local
agents.

## Publish skills

Install the standalone ClawHub CLI for publisher workflows:

```bash
npm i -g clawhub
=======
description: "Search, install, update, sync, or publish agent skills with the ClawHub CLI and registry."
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

Auth (publish)

```bash
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
clawhub login
clawhub whoami
```

<<<<<<< HEAD
Publish or sync skills:

```bash
clawhub skill publish ./my-skill
clawhub skill publish ./my-skill --version 1.2.3
clawhub sync --all
```

## Notes

- Public registry: https://clawhub.ai
- `openclaw skills install` installs into the active workspace by default.
- Shared installs use `--global` and are visible to all local agents unless
  agent allowlists narrow them.
=======
Search

```bash
clawhub search "postgres backups"
```

Install

```bash
clawhub install my-skill
clawhub install my-skill --version 1.2.3
```

Update (hash-based match + upgrade)

```bash
clawhub update my-skill
clawhub update my-skill --version 1.2.3
clawhub update --all
clawhub update my-skill --force
clawhub update --all --no-input --force
```

List

```bash
clawhub list
```

Publish

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.2.0 --changelog "Fixes + docs"
```

Notes

- Default registry: https://clawhub.com (override with CLAWHUB_REGISTRY or --registry)
- Default workdir: cwd (falls back to OpenClaw workspace); install dir: ./skills (override with --workdir / --dir / CLAWHUB_WORKDIR)
- Update command hashes local files, resolves matching version, and upgrades to latest unless --version is set
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
