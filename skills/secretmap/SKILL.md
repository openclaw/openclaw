---
name: secretmap
description: Scan codebases for credentials, API keys, tokens, and secrets — build a full inventory.
homepage: https://www.npmjs.com/package/secretmap
metadata: { "openclaw": { "emoji": "🔐", "requires": { "anyBins": ["npx"] } } }
---

# SecretMap

Discover and inventory credentials, API keys, tokens, and secrets across your codebase.

## Quick start

Scan current directory:

```bash
npx secretmap .
```

Scan a specific project:

```bash
npx secretmap /path/to/project
```

## Useful flags

- `--json` — machine-readable JSON output
- `--verbose` — show additional context for each finding
- `--ignore <pattern>` — skip files matching pattern

## Common use cases

**"Scan for leaked credentials":**

```bash
npx secretmap . --json | jq '.findings[] | {file, type, line}'
```

**"Audit my secrets":**

```bash
npx secretmap . --verbose
```

**"Check before committing":**

```bash
npx secretmap . --json && echo "No secrets found" || echo "Secrets detected!"
```
