---
name: activihub
description: Use the ActiviHub CLI to search, install, update, and publish agent skills from activihub.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed activihub CLI.
metadata:
  {
    "activi":
      {
        "requires": { "bins": ["activihub"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "activihub",
              "bins": ["activihub"],
              "label": "Install ActiviHub CLI (npm)",
            },
          ],
      },
  }
---

# ActiviHub CLI

Install

```bash
npm i -g activihub
```

Auth (publish)

```bash
activihub login
activihub whoami
```

Search

```bash
activihub search "postgres backups"
```

Install

```bash
activihub install my-skill
activihub install my-skill --version 1.2.3
```

Update (hash-based match + upgrade)

```bash
activihub update my-skill
activihub update my-skill --version 1.2.3
activihub update --all
activihub update my-skill --force
activihub update --all --no-input --force
```

List

```bash
activihub list
```

Publish

```bash
activihub publish ./my-skill --slug my-skill --name "My Skill" --version 1.2.0 --changelog "Fixes + docs"
```

Notes

- Default registry: https://activihub.com (override with ACTIVIHUB_REGISTRY or --registry)
- Default workdir: cwd (falls back to Activi workspace); install dir: ./skills (override with --workdir / --dir / ACTIVIHUB_WORKDIR)
- Update command hashes local files, resolves matching version, and upgrades to latest unless --version is set
