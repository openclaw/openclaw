# GITHUB_WORKFLOW.md — The Agent's Guide to GitHub

> **Mandatory for all 100 agents.** Read this before touching any code.  
> Enforced by: @Gustavo (git-specialist, GitHub Platform Specialist)

---

## Overview

Every code change follows this lifecycle:

```
PLAN → BRANCH → CODE → QUALITY GATES → COMMIT → PUSH → PR → REVIEW → MERGE
```

Breaking any step = @Gustavo alerts @main. No exceptions.

---

## BEFORE You Code

### 1. Always Work on a Branch

```bash
# From the project root
cd ~/Desenvolvimento/openclawdev

# Sync with our working branch
git fetch origin
git checkout claude/nice-raman
git pull --rebase origin claude/nice-raman

# Create your feature branch FROM our working branch
git checkout -b feat/your-feature-name
```

**Branch naming:**
| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/<scope>-<what>` | `feat/memory-consolidation` |
| Fix | `fix/<scope>-<what>` | `fix/auth-token-isolation` |
| Refactor | `refactor/<scope>` | `refactor/context-builder` |
| Docs | `docs/<scope>` | `docs/auto-memory-guide` |
| Chore | `chore/<what>` | `chore/update-deps` |

### 2. Understand What Exists

```bash
# Check what files are relevant
find ~/Desenvolvimento/openclawdev/src -name "*<term>*"
grep -ri "<concept>" ~/Desenvolvimento/openclawdev/src/ --include="*.ts" | head -10
```

**If a concept doesn't exist in the codebase, ask @CTO (cto agent) before creating it.**

### 3. Check Open Issues / PRs

```bash
gh issue list --repo jcafeitosa/openclawdev --state open --limit 5
gh pr list --repo jcafeitosa/openclawdev --state open --limit 5
```

Don't duplicate work already in progress.

---

## DURING Coding

### Commit Often, Commit Well

**Conventional Commits format (mandatory):**
```
<type>(<scope>): <imperative subject, max 72 chars>

[optional body explaining WHY, not what]

Co-Authored-By: Claude <noreply@anthropic.com>
```

**Types:**
| Type | When |
|------|------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code restructure without behavior change |
| `test` | Add or fix tests |
| `docs` | Documentation only |
| `chore` | Build, deps, config |
| `perf` | Performance improvement |
| `security` | Security hardening |

**Examples:**
```bash
# ✅ Good
git commit -m "feat(memory): add decay-based retention scoring

Implements Ebbinghaus-inspired forgetting curve so old memories
fade unless reinforced. Reduces context window usage ~40%.

Co-Authored-By: Claude <noreply@anthropic.com>"

# ✅ Good (short)
git commit -m "fix(test): isolate gateway token from process.env in runtime-config test

Co-Authored-By: Claude <noreply@anthropic.com>"

# ❌ Bad
git commit -m "update stuff"
git commit -m "WIP"
git commit -m "fix"
```

### Push Frequently

```bash
git push origin feat/your-feature-name
```

**Rule: never accumulate more than 3 unpushed commits.** If you do, @Gustavo will alert @main.

### Keep the Working Tree Clean

Never leave files untracked. Either:
- Add them to a commit: `git add . && git commit`
- Or gitignore them: `echo "pattern" >> .gitignore`

---

## Quality Gates (MANDATORY before any commit)

Run these in order. **All must pass before committing:**

```bash
# 1. Lint — zero tolerance
pnpm exec oxlint src/ extensions/ ui/src/
# Expected: "Found 0 warnings and 0 errors."

# 2. Format
pnpm exec oxfmt src/ extensions/ ui/src/
# Expected: no output (already formatted)

# 3. Build
pnpm build
# Expected: exit 0

# 4. Tests
pnpm exec vitest run
# Expected: 0 failures
```

**If ANY fails → fix it first. Don't bypass with `--no-verify` unless @CTO approves.**

---

## AFTER Coding — Opening a PR

### 1. Pre-PR Checklist

```bash
# Clean tree
git status --short   # must be empty

# No unpushed commits
git log origin/$(git branch --show-current)..HEAD --oneline  # must be empty

# All quality gates pass (see above)
```

### 2. Create the PR

```bash
gh pr create \
  --repo jcafeitosa/openclawdev \
  --base claude/nice-raman \
  --title "type(scope): clear description" \
  --fill   # opens editor with template
```

**PR title must follow Conventional Commits** — same as commit messages.

### 3. Fill the PR Template

The template has mandatory sections:
- **Summary**: 2–5 bullets (problem, why, what changed, what didn't)
- **Change Type**: check all that apply
- **Security Impact**: answer ALL 5 yes/no questions
- **Evidence**: at minimum, attach test output
- **Human Verification**: what YOU verified, not just CI

**Incomplete PRs will be rejected by @Gustavo.**

### 4. Notify the Team

After opening a PR:
```
[@main -> @team] 📌 PR opened: #N — "title"
Files changed: [key files]
Tests: passing ✅
Needs review: @[relevant-specialist]
```

### 5. Monitor Your PR

```bash
# Watch CI
gh pr checks <PR-number>

# Watch runs
gh run watch --repo jcafeitosa/openclawdev
```

If CI fails → fix immediately, don't wait.

---

## Code Review Standards

### As Author

1. Self-review before requesting: read your own diff
2. Respond to reviews within **5 minutes** (agent speed)
3. Address every comment — either fix or explain why not
4. Re-request review after changes
5. **Never merge your own PR without a second agent review**

### As Reviewer

1. Acknowledge within **1 minute**
2. Review within **5 minutes**
3. Check:
   - [ ] Tests cover the change
   - [ ] No security issues (new secrets, unvalidated input, new perms)
   - [ ] TypeScript types are correct (no `any`, no `!` assertions without comment)
   - [ ] Error handling present
   - [ ] No unused imports or variables
   - [ ] Commit messages follow Conventional Commits
4. Either LGTM or list specific changes required

### LGTM Criteria

```
✅ Tests: new tests for new behavior, existing tests pass
✅ Types: fully typed, no TS errors
✅ Security: no new attack surface
✅ Docs: README/inline docs updated if public API changed
✅ Scope: only touches what the PR says it touches
```

---

## Merging

Only merge when:
1. At least 1 agent approved (LGTM)
2. All CI checks green
3. No unresolved comments

```bash
# Squash merge for clean history (default for features)
gh pr merge <N> --squash --delete-branch

# Merge commit for larger features (preserves history)
gh pr merge <N> --merge --delete-branch
```

**After merge → always delete the feature branch.**

---

## Issue Management

### Filing Issues

Use GitHub issues for:
- Bugs found during work (not just TODO comments in code)
- Features that are out of scope of current PR
- Tech debt that needs scheduling

```bash
gh issue create \
  --repo jcafeitosa/openclawdev \
  --title "fix(scope): description" \
  --body "## Problem\n\n## Expected\n\n## Actual\n\n## Steps to reproduce" \
  --label "bug"
```

### Referencing Issues

In commits and PRs:
```bash
# Close issue on merge
git commit -m "fix(auth): resolve token isolation in tests

Closes #42

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Upstream Sync (openclaw/openclaw → our fork)

Checked daily by @Gustavo. If upstream has relevant changes:

```bash
cd ~/Desenvolvimento/openclawdev
git fetch upstream
git checkout claude/nice-raman
git rebase upstream/main  # or merge if complex
git push --force-with-lease origin claude/nice-raman
```

**Never rebase shared branches without alerting @main first.**

---

## Forbidden Actions 🚫

| Action | Why Forbidden |
|--------|--------------|
| `git push --force` (without `--force-with-lease`) | Destroys history |
| Committing to `main` directly | Always via PR |
| Merging your own PR without review | Quality gate |
| `git commit --no-verify` without CTO approval | Bypasses quality gates |
| Leaving secrets/tokens in code | Security violation |
| `TODO` comments without linked issue | Tech debt orphan |
| Pushing `.env` files | Secret exposure |

---

## @Gustavo's Escalation Path

```
Issue detected
    │
    ├─ Lint/Test failure → Alert @main immediately
    │
    ├─ Dirty working tree → Alert @main + agent (5min grace)
    │
    ├─ Unpushed commits (>3) → Alert @main
    │
    ├─ CI failure on PR → Alert PR author + @main
    │
    ├─ PR template incomplete → Request completion from author
    │
    └─ Upstream 10+ new commits → Daily report to @main
```

---

## Quick Reference

```bash
# Status
git status --short
git log --oneline -5
gh run list --limit 5

# Branch
git checkout -b feat/name
git push origin feat/name

# Quality
pnpm exec oxlint src/ && pnpm build && pnpm exec vitest run

# PR
gh pr create --base claude/nice-raman --fill
gh pr checks <N>
gh pr merge <N> --squash --delete-branch

# Issues
gh issue list --limit 10
gh issue create --title "type: desc" --label bug
```

---

*Maintained by @Gustavo (git-specialist). Last updated: 2026-02-17.*  
*Any questions about GitHub workflow → ping @Gustavo.*
