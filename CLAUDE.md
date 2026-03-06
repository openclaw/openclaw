AGENTS.md

---

## Local Development Workflow

### Managing Local Changes with GitHub Updates

Since OpenClaw is regularly updated from GitHub, we use a separate `local/custom-features` branch to keep your local customizations safe from being overwritten.

**Quick Start:**
```bash
# Update from GitHub while preserving local changes
./scripts/update-local-changes.sh
```

**Manual Steps (if needed):**
```bash
# 1. Fetch latest from GitHub
git fetch origin

# 2. Update main
git checkout main
git reset --hard origin/main

# 3. Rebase your changes on top
git checkout local/custom-features
git rebase main
```

**If conflicts occur:**
```bash
# Fix conflicts in your editor, then:
git add .
git rebase --continue

# Or abort if needed:
git rebase --abort
```

**Branch Strategy:**
- `main` - Always matches GitHub (safe to reset)
- `local/custom-features` - Your local customizations (never force-reset)