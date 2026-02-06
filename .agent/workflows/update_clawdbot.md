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

# Check for Swift 6.2 issues after sync
grep -r "FileManager\.default\|Thread\.isMainThread" src/ apps/ --include="*.swift"
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

| File             | Resolution                                       |
| ---------------- | ------------------------------------------------ |
| `package.json`   | Take upstream deps, keep local scripts if needed |
| `pnpm-lock.yaml` | Accept upstream, regenerate with `pnpm install`  |
| `*.patch` files  | Usually take upstream version                    |
| Source files     | Merge logic carefully, prefer upstream structure |

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

## Step 5: Handle Swift/macOS Build Issues (Common After Upstream Sync)

Upstream updates may introduce Swift 6.2 / macOS 26 SDK incompatibilities. Use analyze-mode for systematic debugging:

### Analyze-Mode Investigation

```bash
# Gather context with parallel agents
morph-mcp_warpgrep_codebase_search search_string="Find deprecated FileManager.default and Thread.isMainThread usages in Swift files" repo_path="/Volumes/Main SSD/Developer/clawdis"
morph-mcp_warpgrep_codebase_search search_string="Locate Peekaboo submodule and macOS app Swift files with concurrency issues" repo_path="/Volumes/Main SSD/Developer/clawdis"
```

### Common Swift 6.2 Fixes

**FileManager.default Deprecation:**

```bash
# Search for deprecated usage
grep -r "FileManager\.default" src/ apps/ --include="*.swift"

# Replace with proper initialization
# OLD: FileManager.default
# NEW: FileManager()
```

**Thread.isMainThread Deprecation:**

```bash
# Search for deprecated usage
grep -r "Thread\.isMainThread" src/ apps/ --include="*.swift"

# Replace with modern concurrency check
# OLD: Thread.isMainThread
# NEW: await MainActor.run { ... } or DispatchQueue.main.sync { ... }
```

### Peekaboo Submodule Fixes

```bash
# Check Peekaboo for concurrency issues
cd src/canvas-host/a2ui
grep -r "Thread\.isMainThread\|FileManager\.default" . --include="*.swift"

# Fix and rebuild submodule
cd /Volumes/Main SSD/Developer/clawdis
pnpm canvas:a2ui:bundle
```

### macOS App Concurrency Fixes

```bash
# Check macOS app for issues
grep -r "Thread\.isMainThread\|FileManager\.default" apps/macos/ --include="*.swift"

# Clean and rebuild after fixes
cd apps/macos && rm -rf .build .swiftpm
./scripts/restart-mac.sh
```

### Model Configuration Updates

If upstream introduced new model configurations:

```bash
# Check for OpenRouter API key requirements
grep -r "openrouter\|OPENROUTER" src/ --include="*.ts" --include="*.js"

# Update clawdbot.json with fallback chains
# Add model fallback configurations as needed
```

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

### Swift 6.2 / macOS 26 SDK Build Failures

**Symptoms:** Build fails with deprecation warnings about `FileManager.default` or `Thread.isMainThread`

**Search-Mode Investigation:**

```bash
# Exhaustive search for deprecated APIs
morph-mcp_warpgrep_codebase_search search_string="Find all Swift files using deprecated FileManager.default or Thread.isMainThread" repo_path="/Volumes/Main SSD/Developer/clawdis"
```

**Quick Fix Commands:**

```bash
# Find all affected files
find . -name "*.swift" -exec grep -l "FileManager\.default\|Thread\.isMainThread" {} \;

# Replace FileManager.default with FileManager()
find . -name "*.swift" -exec sed -i '' 's/FileManager\.default/FileManager()/g' {} \;

# For Thread.isMainThread, need manual review of each usage
grep -rn "Thread\.isMainThread" --include="*.swift" .
```

**Rebuild After Fixes:**

```bash
# Clean all build artifacts
rm -rf apps/macos/.build apps/macos/.swiftpm
rm -rf src/canvas-host/a2ui/.build

# Rebuild Peekaboo bundle
pnpm canvas:a2ui:bundle

# Full macOS rebuild
./scripts/restart-mac.sh
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

echo "==> Checking for Swift 6.2 compatibility issues..."
if grep -r "FileManager\.default\|Thread\.isMainThread" src/ apps/ --include="*.swift" --quiet; then
    echo "⚠️  Found potential Swift 6.2 deprecated API usage"
    echo "   Run manual fixes or use analyze-mode investigation"
else
    echo "✅ No obvious Swift deprecation issues found"
fi

echo "==> Testing agent functionality..."
# Note: Update YOUR_TELEGRAM_SESSION_ID with actual session ID
pnpm clawdbot agent --message "Verification: Upstream sync and macOS rebuild completed successfully." --session-id YOUR_TELEGRAM_SESSION_ID || echo "Warning: Agent test failed - check Telegram for verification message"

echo "==> Done! Check Telegram for verification message, then run 'git push --force-with-lease' when ready."
```
