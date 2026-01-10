---
description: Update Clawdbot from upstream when branch has diverged (ahead/behind)
---

# Clawdbot Upstream Sync Workflow

Use this workflow when your fork has diverged from upstream (e.g., "18 commits ahead, 29 commits behind").

## Quick Reference

```bash
# Check divergence status
git fetch upstream && git rev-list --left-right --count main...upstream/main

# Full sync (rebase preferred)
git fetch upstream && git rebase upstream/main && pnpm install && pnpm build && ./scripts/restart-mac.sh
```

---

## Step 1: Assess Divergence

```bash
git fetch upstream
git log --oneline --left-right main...upstream/main | head -20
```

This shows:
- `<` = your local commits (ahead)
- `>` = upstream commits you're missing (behind)

**Decision point:**
- Few local commits, many upstream → **Rebase** (cleaner history)
- Many local commits or shared branch → **Merge** (preserves history)

---

## Step 2A: Rebase Strategy (Preferred)

Replays your commits on top of upstream. Results in linear history.

```bash
# Ensure working tree is clean
git status

# Rebase onto upstream
git rebase upstream/main
```

### Handling Rebase Conflicts

```bash
# When conflicts occur:
# 1. Fix conflicts in the listed files
# 2. Stage resolved files
git add <resolved-files>

# 3. Continue rebase
git rebase --continue

# If a commit is no longer needed (already in upstream):
git rebase --skip

# To abort and return to original state:
git rebase --abort
```

### Common Conflict Patterns

| File | Resolution |
|------|------------|
| `package.json` | Take upstream deps, keep local scripts if needed |
| `pnpm-lock.yaml` | Accept upstream, regenerate with `pnpm install` |
| `*.patch` files | Usually take upstream version |
| Source files | Merge logic carefully, prefer upstream structure |

---

## Step 2B: Merge Strategy (Alternative)

Preserves all history with a merge commit.

```bash
git merge upstream/main --no-edit
```

Resolve conflicts same as rebase, then:
```bash
git add <resolved-files>
git commit
```

---

## Step 3: Rebuild Everything

After sync completes:

```bash
# Install dependencies (regenerates lock if needed)
pnpm install

# Build TypeScript
pnpm build

# Build UI assets
pnpm ui:build

# Run diagnostics
pnpm clawdbot doctor
```

---

## Step 4: Rebuild macOS App

```bash
# Full rebuild, sign, and launch
./scripts/restart-mac.sh

# Or just package without restart
pnpm mac:package
```

### Install to /Applications

```bash
# Kill running app
pkill -x "Clawdbot" || true

# Move old version
mv /Applications/Clawdbot.app /tmp/Clawdbot-backup.app

# Install new build
cp -R dist/Clawdbot.app /Applications/

# Launch
open /Applications/Clawdbot.app
```

---

## Step 4A: Verify macOS App & Agent

After rebuilding the macOS app, always verify it works correctly:

```bash
# Check gateway health
pnpm clawdbot health

# Verify no zombie processes
ps aux | grep -E "(clawdbot|gateway)" | grep -v grep

# Test agent functionality by sending a verification message
pnpm clawdbot agent --message "Verification: macOS app rebuild successful - agent is responding." --session-id YOUR_TELEGRAM_SESSION_ID

# Confirm the message was received on Telegram
# (Check your Telegram chat with the bot)
```

**Important:** Always wait for the Telegram verification message before proceeding. If the agent doesn't respond, troubleshoot the gateway or model configuration before pushing.

---

## Step 6: Verify & Push

```bash
# Verify everything works
pnpm clawdbot health
pnpm test

# Push (force required after rebase)
git push origin main --force-with-lease

# Or regular push after merge
git push origin main
```

---

## Troubleshooting

### Build Fails After Sync

```bash
# Clean and rebuild
rm -rf node_modules dist
pnpm install
pnpm build
```

### Type Errors (Bun/Node Incompatibility)

Common issue: `fetch.preconnect` type mismatch. Fix by using `FetchLike` type instead of `typeof fetch`.

### macOS App Crashes on Launch

Usually resource bundle mismatch. Full rebuild required:
```bash
cd apps/macos && rm -rf .build .swiftpm
./scripts/restart-mac.sh
```

### Patch Failures

```bash
# Check patch status
pnpm install 2>&1 | grep -i patch

# If patches fail, they may need updating for new dep versions
# Check patches/ directory against package.json patchedDependencies
```

---

## Automation Script

Save as `scripts/sync-upstream.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "==> Fetching upstream..."
git fetch upstream

echo "==> Current divergence:"
git rev-list --left-right --count main...upstream/main

echo "==> Rebasing onto upstream/main..."
git rebase upstream/main

echo "==> Installing dependencies..."
pnpm install

echo "==> Building..."
pnpm build
pnpm ui:build

echo "==> Running doctor..."
pnpm clawdbot doctor

echo "==> Rebuilding macOS app..."
./scripts/restart-mac.sh

echo "==> Verifying gateway health..."
pnpm clawdbot health

echo "==> Testing agent functionality..."
# Note: Update YOUR_TELEGRAM_SESSION_ID with actual session ID
pnpm clawdbot agent --message "Verification: Upstream sync and macOS rebuild completed successfully." --session-id YOUR_TELEGRAM_SESSION_ID || echo "Warning: Agent test failed - check Telegram for verification message"

echo "==> Done! Check Telegram for verification message, then run 'git push --force-with-lease' when ready."
```
