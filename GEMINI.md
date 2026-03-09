# GEMINI.md — Gemini CLI Guide: OpenClaw Source Repo

> This is Gemini CLI's companion to `CLAUDE.md` (symlinked from `AGENTS.md`).
> Claude is the **planner and validator**. Gemini is the **executor**.
> Always read `CLAUDE.md` first for project conventions, then this file for your specific role.

---

## Your Role in This Repo

You make surgical, targeted changes to the OpenClaw **source code** based on plans provided by Claude. You do not design architecture — you implement it. When in doubt, ask Claude to revise the plan rather than improvising.

**Always read Claude's plan file before touching code:**

```
cat /home/woodripper/.openclaw/workspace/collab/CURRENT-PLAN.md
```

---

## Repo Layout (Key Paths)

```
openclaw/
  src/                    ← TypeScript source (edit here, not dist/)
    agents/               ← Agent runner, subagent spawn, tools
    config/               ← Config loading, path resolution, schema
    node-host/            ← Exec isolation, system-run policy
    infra/                ← Home dir, env sanitization, device identity
    media/                ← Inbound path policy (patched for Linux)
  dist/                   ← Compiled output — DO NOT edit manually
  docs/                   ← Documentation
  extensions/             ← Channel plugins (Telegram, Discord, etc.)
  CLAUDE.md               ← Full repo guide (read this first)
  GEMINI.md               ← This file
```

---

## Commands You Are Authorized to Run

```bash
# Build after source changes
pnpm run build            # or: bun run build

# Run tests for changed file
pnpm vitest run src/path/to/changed.test.ts

# Run all tests (avoid unless full validation needed — slow)
pnpm vitest run

# Git operations
git status
git diff
git add <specific-file>   # NEVER: git add -A or git add .
git commit -m "..."
git push origin main

# Check for stale paths after edits
grep -rn "/Users/" src/ dist/ --include="*.ts" --include="*.js" | grep -v "node_modules"
```

---

## Critical Rules

1. **Never edit `dist/` files directly.** Edit `src/`, then build.
2. **Never `git add .` or `git add -A`** — always add specific files.
3. **Never push without Claude's PASS validation.**
4. **Never embed secrets in source files.** Config keys belong in `.openclaw/openclaw.json` or Bitwarden.
5. **The pre-commit hook will block secret patterns.** If it fires, stop and tell Claude.

---

## Custom Branches in This Fork

| Branch                          | Purpose                   |
| ------------------------------- | ------------------------- |
| `fix/browser-snap-clean`        | Browser snap cleanup fix  |
| `fix/browser-snap-origin`       | Browser origin fix        |
| `fix/browser-snap-userdata-dir` | Browser user data dir fix |

When making changes, create a new branch from `main`:

```bash
git checkout -b fix/<description>
# ... make changes ...
git push origin fix/<description>
```

---

## Linux Compatibility Notes (WoodRipper-Specific)

This fork runs on **Linux (Ubuntu, user: woodripper)**. The upstream was developed on macOS. Watch for:

- **Path assumptions:** No `/Users/` paths. Home is `/home/woodripper`.
- **`os.homedir()`** returns `/home/woodripper` on this system, not `/Users/woodripper`.
- **`process.platform`** is `"linux"`, not `"darwin"`.
- **Socket paths** must be under `/home/woodripper/.openclaw/`, not `/Users/`.
- **Snap/browser paths** differ from macOS (see browser snap branches).

Known patched file: `src/media/inbound-path-policy.ts` — already fixed for Linux.

---

## Handoff to Claude for Validation

After making changes, write a summary to:

```
/home/woodripper/.openclaw/workspace/collab/VALIDATION-REPORT.md
```

Format:

```markdown
# Gemini Execution Report

**Task:** <task name>
**Files Changed:** list
**Commands Run:** list
**Git Status:** <output of git status>
**Notes:** any issues or deviations from plan
```

Then notify Claude: "Changes complete. Please validate."

---

## Upstream PR Workflow

If a fix should be contributed back to `openclaw/openclaw`:

1. Confirm with Claude the fix is generic (not WoodRipper-specific)
2. Create a branch: `git checkout -b fix/<description>`
3. Claude writes the PR description
4. Push: `git push origin fix/<description>`
5. Open PR via: `gh pr create --base openclaw:main`
