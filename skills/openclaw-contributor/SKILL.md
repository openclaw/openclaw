---
name: openclaw-contributor
description: "Contribute to the OpenClaw core repository: pick issues, inspect bundled skills, make focused changes, run the right level of validation, and open a clean PR. Use when working specifically on openclaw/openclaw or a fork. Not for generic git usage or unrelated GitHub repos."
metadata:
  {
    "openclaw":
      {
        "emoji": "🦞",
        "requires": { "bins": ["gh", "git", "pnpm"] },
        "install":
          [
            {
              "id": "brew-gh",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
          ],
      },
  }
---

# OpenClaw Contributor

Use this skill when contributing directly to `openclaw/openclaw` or a fork of it.

## When to Use

✅ **USE this skill when:**

- fixing an OpenClaw bug or implementing an OpenClaw feature
- adding or improving a bundled skill under `skills/`
- preparing a clean fork → branch → commit → PR workflow
- checking nearby code, docs, tests, and issue context before changing anything
- coordinating multiple agents for research, implementation, and PR polish

## When NOT to Use

❌ **DON'T use this skill when:**

- doing generic local git work unrelated to OpenClaw
- working on a different repository with different contribution norms
- using GitHub only for issues/PR status → use the `github` skill
- doing broad autonomous issue farming across many repos → use `gh-issues`

## Quick Orientation

Important paths in the OpenClaw repo:

```bash
skills/            # bundled skills
packages/          # package sources (if present in current layout)
docs/              # documentation
scripts/           # build, release, and utility scripts
package.json       # scripts: build, lint, test, dev
```

Useful first checks:

```bash
# Verify auth
gh auth status

# See open issues
gh issue list --repo openclaw/openclaw --state open --limit 30

# Inspect a bundled skill
ls skills/
sed -n '1,160p' skills/github/SKILL.md

# See repo scripts
node -e "const p=require('./package.json'); console.log(p.packageManager); console.log(p.scripts)"
```

## Standard Contribution Flow

### 1. Start from a fork

```bash
gh repo fork openclaw/openclaw --clone
cd openclaw

git remote add upstream https://github.com/openclaw/openclaw.git 2>/dev/null || true
git fetch upstream
```

### 2. Create a focused branch

```bash
git checkout -b feat/my-change
# or
# git checkout -b fix/my-change
# git checkout -b docs/my-change
```

### 3. Inspect before editing

Before changing anything:

- read the nearest comparable file first
- preserve the existing repo tone and structure
- keep skill directories minimal: normally just `SKILL.md`, plus `scripts/` or `references/` only when truly needed
- do **not** add extra files like `README.md`, `CHANGELOG.md`, or installation guides inside a skill directory

For skill work specifically:

```bash
sed -n '1,200p' skills/skill-creator/SKILL.md
sed -n '1,200p' skills/github/SKILL.md
```

### 4. Make the smallest useful change

Guidelines:

- prefer one clear improvement over a grab-bag PR
- match existing command style and frontmatter format
- avoid hype, speculation, or unverifiable claims in bundled content
- if adding a skill, make the description triggerable and specific
- if instructions vary by scenario, keep the overview in `SKILL.md` and move heavy detail to `references/`

### 5. Run the right level of validation

For **docs / markdown / skill-only** changes:

```bash
git diff --check
```

For **runtime / CLI / core** changes:

```bash
pnpm lint
pnpm test
```

For **targeted investigation** before full test runs:

```bash
node -e "const p=require('./package.json'); console.log(p.scripts.test)"
```

Do not claim tests were run if they were not.

### 6. Commit clearly

```bash
git add <files>
git commit -m "feat(skills): add openclaw contributor skill"
```

Good commit / PR title patterns:

- `feat(skills): add openclaw contributor skill`
- `fix(gateway): reduce repeated file read context bloat`
- `docs(skills): clarify bundled skill structure`

### 7. Push and open PR

```bash
git push -u origin HEAD

gh pr create \
  --repo openclaw/openclaw \
  --title "feat(skills): add openclaw contributor skill" \
  --body-file .github/pr-body.md
```

If no PR body file exists, write one first.

## PR Body Template

Create a short, factual body:

```markdown
## Summary
- add a bundled `openclaw-contributor` skill
- document repo-specific contribution workflow for OpenClaw contributors

## Why
OpenClaw ships many bundled skills but does not yet include one focused on contributing back to the OpenClaw repo itself.

## Validation
- reviewed nearby bundled skills for structure and tone
- ran `git diff --check`
```

Only mention `pnpm lint` / `pnpm test` if you actually ran them.

## Multi-Agent Pattern

For larger changes, split work into three roles:

1. **Researcher** — issue triage, codebase reconnaissance, similar-file scan
2. **Implementer** — smallest correct patch, local validation
3. **Reviewer** — PR body, risk scan, regression checklist

Keep one agent responsible for final judgment and commit quality.

## Handy Commands

```bash
# Find candidate issues
gh issue list --repo openclaw/openclaw --state open --limit 50

# View one issue
gh issue view 12345 --repo openclaw/openclaw

# See changed files before commit
git diff --stat

# Check branch state
git status --short

# See recent upstream changes
git log --oneline --decorate --graph -20
```

## Notes

- Bundled skills should feel production-ready, not personal.
- Prefer repo-specific accuracy over generic open-source advice.
- If a contribution depends on undocumented assumptions, open an issue instead of guessing.
- When in doubt, ship the smaller PR first.
