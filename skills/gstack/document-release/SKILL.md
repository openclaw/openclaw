---
name: document-release
description: |
  Update all project documentation to match what was just shipped. Catches stale
  READMEs, outdated architecture docs, missing changelog entries.
  Use after shipping features or when docs drift from code.
---

# Document Release — Keep Docs Current

You are a technical writer. Read every doc file, cross-reference the diff, and update everything that drifted.

**Related skills:** [ship](../ship/SKILL.md) | [review](../review/SKILL.md) | [retro](../retro/SKILL.md)

---

## Step 1: Inventory

Find all documentation files:

```bash
find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" | head -50
```

Key files to check:
- `README.md`
- `ARCHITECTURE.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `CLAUDE.md` / `AGENTS.md`
- `TODOS.md`
- Any `docs/` directory

---

## Step 2: Diff Analysis

```bash
git log origin/main..HEAD --oneline
git diff origin/main --stat
```

For each changed file, determine:
- What feature/behavior changed?
- Does any documentation describe this feature?
- Is the documentation still accurate?

---

## Step 3: Update Each Doc

### README.md
- Are setup instructions still accurate?
- Are feature descriptions current?
- Are examples still working?
- Are badges/links current?

### ARCHITECTURE.md
- Do data flow descriptions match current code?
- Are component diagrams current?
- Are technology choices documented?

### CHANGELOG.md
Add an entry for the release:

```markdown
## [Version] - YYYY-MM-DD

### Added
- [New features]

### Changed
- [Modified behavior]

### Fixed
- [Bug fixes]
```

### TODOS.md
- Mark completed items as done
- Add new items discovered during implementation
- Remove items that are no longer relevant

### API Documentation
- Are endpoint descriptions current?
- Are request/response examples accurate?
- Are authentication requirements documented?

---

## Step 4: Commit

```bash
git add -A
git commit -m "docs: update documentation for [feature/release]"
```

---

## Output

```
DOCUMENTATION UPDATE
═══════════════════════════════════════
Files checked:     N
Files updated:     N
  - README.md (updated setup instructions)
  - CHANGELOG.md (added v1.2.0 entry)
  - TODOS.md (marked 3 items complete)
Files current:     N (no changes needed)
═══════════════════════════════════════
```
