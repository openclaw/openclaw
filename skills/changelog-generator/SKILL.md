---
name: changelog-generator
description: "Generate changelogs from git history. Parses conventional commits, groups by type, and outputs Keep a Changelog or custom markdown. Use when: user asks to generate a changelog, release notes, or summarize changes between tags/commits. NOT for: writing commit messages (just follow conventional commits), or detailed code review (use github skill)."
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "requires": { "bins": ["git"] },
      },
  }
---

# Changelog Generator

Generate structured changelogs from git commit history.

## When to Use

✅ **USE this skill when:**

- "Generate a changelog"
- "What changed since last release?"
- "Write release notes for v2.0"
- "Summarize commits between tags"
- Preparing a release and need formatted notes

## When NOT to Use

❌ **DON'T use this skill when:**

- Writing individual commit messages
- Doing code review → use github skill
- Need CI/CD release automation → use github-actions or similar

## Workflow

### 1. Identify the Range

Determine the commit range. Common patterns:

```bash
# Between two tags
git log v1.0.0..v2.0.0 --oneline

# Since last tag
git log $(git describe --tags --abbrev=0)..HEAD --oneline

# Last N commits
git log -20 --oneline

# Between dates
git log --after="2024-01-01" --before="2024-02-01" --oneline

# All tags (to pick a range)
git tag --sort=-version:refname | head -10
```

### 2. Extract Commits

Use structured format for parsing:

```bash
# Full details for changelog
git log v1.0.0..HEAD --pretty=format:"%H|%s|%an|%ad" --date=short

# With body (for breaking changes, etc.)
git log v1.0.0..HEAD --pretty=format:"COMMIT_START%nHash: %H%nSubject: %s%nAuthor: %an%nDate: %ad%nBody: %b%nCOMMIT_END" --date=short
```

### 3. Classify Commits

Group by [Conventional Commits](https://www.conventionalcommits.org/) type:

| Prefix | Changelog Section |
|--------|------------------|
| `feat:` / `feat(scope):` | ✨ Features |
| `fix:` / `fix(scope):` | 🐛 Bug Fixes |
| `docs:` | 📚 Documentation |
| `perf:` | ⚡ Performance |
| `refactor:` | ♻️ Refactoring |
| `test:` | 🧪 Tests |
| `build:` / `ci:` | 🔧 Build & CI |
| `chore:` | 🏠 Chores |
| `BREAKING CHANGE` / `!:` | 💥 Breaking Changes |

Non-conventional commits go under **Other Changes**.

### 4. Output Format

Use [Keep a Changelog](https://keepachangelog.com/) format:

```markdown
# Changelog

## [2.0.0] - 2024-03-15

### 💥 Breaking Changes

- **api:** Remove deprecated `/v1/users` endpoint (#234)

### ✨ Features

- **auth:** Add OAuth2 PKCE flow support (#220)
- **ui:** New dashboard layout with dark mode (#215)

### 🐛 Bug Fixes

- **core:** Fix memory leak in connection pool (#228)
- Fix timezone handling in scheduler (#225)

### 📚 Documentation

- Update API migration guide for v2 (#230)

### ⚡ Performance

- **db:** Optimize query for large datasets (#222)
```

### 5. Include Metadata (Optional)

When helpful, append a summary footer:

```markdown
---

**Full diff:** [`v1.0.0...v2.0.0`](https://github.com/org/repo/compare/v1.0.0...v2.0.0)
**Contributors:** @alice, @bob, @charlie
```

Get contributors with:

```bash
git log v1.0.0..HEAD --pretty=format:"%an" | sort -u
```

## Tips

- **No conventional commits?** Summarize each commit in plain English. Group by area/file if possible.
- **Squash merges?** Use PR titles: `git log --merges --first-parent --oneline`
- **Monorepo?** Filter by path: `git log v1.0.0..HEAD -- packages/core/`
- **Link PRs/issues:** Match `(#123)` patterns and link to the repo's issue tracker.
- **Breaking changes:** Always put these first and make them prominent.
- **Keep it human-readable:** The LLM should rewrite terse commit messages into clear changelog entries.

## Quick Command

Generate raw material for a changelog in one shot:

```bash
git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~20")..HEAD \
  --pretty=format:"- %s (%an, %ad)" --date=short
```

## Notes

- No external tools needed — just `git`
- Works with any git repo (GitHub, GitLab, local)
- For GitHub repos, consider enriching with PR data: `gh pr list --state merged --limit 50 --json title,number,labels`
