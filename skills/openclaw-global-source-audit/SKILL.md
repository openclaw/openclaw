---
name: openclaw-global-source-audit
description: Open-source multi-region code-audit support for OpenClaw, combining trusted source watch evidence and local seam-audit checks in read-only mode.
metadata: { "openclaw": { "criticality": "important" } }
---

# OpenClaw Global Source Audit

Use this skill when OpenClaw needs source-backed code-audit evidence from public/open sources plus local repository seam checks.

## Scope

- Covers open-source/global signals through the existing source-watch registry (official site, GitHub org, issues/discussions, Reddit, and third-party discovery).
- Runs local code seam audit and fast audit checks for practical code-audit support.
- Works only inside `D:\OpenClaw`.
- No login, no private group access, no external writes, and no runtime mutation.

## Commands

Build and verify source-watch evidence:

```powershell
pnpm autonomous:source-watch:registry
pnpm autonomous:source-watch:registry:check
```

Run local seam audit support:

```powershell
pnpm audit:seams
pnpm test:unit:fast:audit
```

Re-validate autonomous inventory contract:

```powershell
pnpm autonomous:inventory:check
```

## Outputs

- `reports/openclaw-source-watch-registry-latest.json`
- JSON seam-audit output (stdout)

## Output Shape

- Core result
- Files changed
- Validation result
- Next task
