---
name: neohub
description: Use the NeoHub CLI to search, install, update, and publish agent skills from neohub.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed neohub CLI.
metadata:
  {
    "smart-agent-neo":
      {
        "requires": { "bins": ["neohub"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "neohub",
              "bins": ["neohub"],
              "label": "Install NeoHub CLI (npm)",
            },
          ],
      },
  }
---

# NeoHub CLI

Install

```bash
npm i -g neohub
```

Auth (publish)

```bash
neohub login
neohub whoami
```

Search

```bash
neohub search "postgres backups"
```

Install

```bash
neohub install my-skill
neohub install my-skill --version 1.2.3
```

Update (hash-based match + upgrade)

```bash
neohub update my-skill
neohub update my-skill --version 1.2.3
neohub update --all
neohub update my-skill --force
neohub update --all --no-input --force
```

List

```bash
neohub list
```

Publish

```bash
neohub publish ./my-skill --slug my-skill --name "My Skill" --version 1.2.0 --changelog "Fixes + docs"
```

Notes

- Default registry: https://neohub.com (override with NEOHUB_REGISTRY or --registry)
- Default workdir: cwd (falls back to SmartAgentNeo workspace); install dir: ./skills (override with --workdir / --dir / NEOHUB_WORKDIR)
- Update command hashes local files, resolves matching version, and upgrades to latest unless --version is set
