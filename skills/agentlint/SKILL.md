---
name: agentlint
description: Lint agent-generated code for common mistakes, anti-patterns, and code smells.
homepage: https://www.npmjs.com/package/@alexmelges/agentlint
metadata: { "openclaw": { "emoji": "🔍", "requires": { "anyBins": ["npx"] } } }
---

# AgentLint

Catch mistakes that AI coding agents commonly make — hallucinated imports, unused variables, placeholder code, and more.

## Quick start

Scan a directory:

```bash
npx @alexmelges/agentlint .
```

Scan a git diff (staged changes only):

```bash
npx @alexmelges/agentlint --diff
```

Scan a specific PR branch:

```bash
git diff main...HEAD | npx @alexmelges/agentlint --stdin
```

## Useful flags

- `--json` — machine-readable JSON output
- `--errors-only` — suppress warnings, show only errors
- `--fix` — auto-fix simple issues
- `--diff` — lint only changed files (git diff)
- `--stdin` — read diff from stdin

## Common use cases

**"Lint this PR":**

```bash
git diff main...HEAD | npx @alexmelges/agentlint --stdin --errors-only
```

**"Scan my project for agent code smells":**

```bash
npx @alexmelges/agentlint . --json | jq '.issues | group_by(.rule) | map({rule: .[0].rule, count: length})'
```

**CI integration:**

```bash
npx @alexmelges/agentlint . --errors-only && echo "Clean" || echo "Issues found"
```
