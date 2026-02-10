---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Update Clawdbot from upstream when branch has diverged (ahead/behind)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Clawdbot Upstream Sync Workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this workflow when your fork has diverged from upstream (e.g., "18 commits ahead, 29 commits behind").（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check divergence status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch upstream && git rev-list --left-right --count main...upstream/main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Full sync (rebase preferred)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch upstream && git rebase upstream/main && pnpm install && pnpm build && ./scripts/restart-mac.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check for Swift 6.2 issues after sync（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grep -r "FileManager\.default\|Thread\.isMainThread" src/ apps/ --include="*.swift"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 1: Assess Divergence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch upstream（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git log --oneline --left-right main...upstream/main | head -20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This shows:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `<` = your local commits (ahead)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `>` = upstream commits you're missing (behind)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Decision point:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Few local commits, many upstream → **Rebase** (cleaner history)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Many local commits or shared branch → **Merge** (preserves history)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 2A: Rebase Strategy (Preferred)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Replays your commits on top of upstream. Results in linear history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Ensure working tree is clean（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Rebase onto upstream（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rebase upstream/main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Handling Rebase Conflicts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# When conflicts occur:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 1. Fix conflicts in the listed files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 2. Stage resolved files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git add <resolved-files>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 3. Continue rebase（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rebase --continue（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# If a commit is no longer needed (already in upstream):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rebase --skip（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# To abort and return to original state:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rebase --abort（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Common Conflict Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| File             | Resolution                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------- | ------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `package.json`   | Take upstream deps, keep local scripts if needed |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `pnpm-lock.yaml` | Accept upstream, regenerate with `pnpm install`  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `*.patch` files  | Usually take upstream version                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Source files     | Merge logic carefully, prefer upstream structure |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 2B: Merge Strategy (Alternative)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preserves all history with a merge commit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git merge upstream/main --no-edit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Resolve conflicts same as rebase, then:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git add <resolved-files>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git commit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 3: Rebuild Everything（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After sync completes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install dependencies (regenerates lock if needed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Build TypeScript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Build UI assets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ui:build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Run diagnostics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm clawdbot doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 4: Rebuild macOS App（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Full rebuild, sign, and launch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./scripts/restart-mac.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or just package without restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm mac:package（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Install to /Applications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Kill running app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pkill -x "Clawdbot" || true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Move old version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mv /Applications/Clawdbot.app /tmp/Clawdbot-backup.app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install new build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cp -R dist/Clawdbot.app /Applications/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Launch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
open /Applications/Clawdbot.app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 4A: Verify macOS App & Agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After rebuilding the macOS app, always verify it works correctly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check gateway health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm clawdbot health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verify no zombie processes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ps aux | grep -E "(clawdbot|gateway)" | grep -v grep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Test agent functionality by sending a verification message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm clawdbot agent --message "Verification: macOS app rebuild successful - agent is responding." --session-id YOUR_TELEGRAM_SESSION_ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Confirm the message was received on Telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# (Check your Telegram chat with the bot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Important:** Always wait for the Telegram verification message before proceeding. If the agent doesn't respond, troubleshoot the gateway or model configuration before pushing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 5: Handle Swift/macOS Build Issues (Common After Upstream Sync)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Upstream updates may introduce Swift 6.2 / macOS 26 SDK incompatibilities. Use analyze-mode for systematic debugging:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Analyze-Mode Investigation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gather context with parallel agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
morph-mcp_warpgrep_codebase_search search_string="Find deprecated FileManager.default and Thread.isMainThread usages in Swift files" repo_path="/Volumes/Main SSD/Developer/clawdis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
morph-mcp_warpgrep_codebase_search search_string="Locate Peekaboo submodule and macOS app Swift files with concurrency issues" repo_path="/Volumes/Main SSD/Developer/clawdis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Common Swift 6.2 Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**FileManager.default Deprecation:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Search for deprecated usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grep -r "FileManager\.default" src/ apps/ --include="*.swift"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Replace with proper initialization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OLD: FileManager.default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# NEW: FileManager()（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Thread.isMainThread Deprecation:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Search for deprecated usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grep -r "Thread\.isMainThread" src/ apps/ --include="*.swift"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Replace with modern concurrency check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OLD: Thread.isMainThread（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# NEW: await MainActor.run { ... } or DispatchQueue.main.sync { ... }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Peekaboo Submodule Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check Peekaboo for concurrency issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd src/canvas-host/a2ui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grep -r "Thread\.isMainThread\|FileManager\.default" . --include="*.swift"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Fix and rebuild submodule（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd /Volumes/Main SSD/Developer/clawdis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm canvas:a2ui:bundle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### macOS App Concurrency Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check macOS app for issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grep -r "Thread\.isMainThread\|FileManager\.default" apps/macos/ --include="*.swift"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Clean and rebuild after fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd apps/macos && rm -rf .build .swiftpm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./scripts/restart-mac.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Model Configuration Updates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If upstream introduced new model configurations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check for OpenRouter API key requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grep -r "openrouter\|OPENROUTER" src/ --include="*.ts" --include="*.js"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Update clawdbot.json with fallback chains（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Add model fallback configurations as needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step 6: Verify & Push（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verify everything works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm clawdbot health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Push (force required after rebase)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git push origin main --force-with-lease（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or regular push after merge（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git push origin main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Build Fails After Sync（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Clean and rebuild（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rm -rf node_modules dist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Type Errors (Bun/Node Incompatibility)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common issue: `fetch.preconnect` type mismatch. Fix by using `FetchLike` type instead of `typeof fetch`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### macOS App Crashes on Launch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Usually resource bundle mismatch. Full rebuild required:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd apps/macos && rm -rf .build .swiftpm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./scripts/restart-mac.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Patch Failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check patch status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install 2>&1 | grep -i patch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# If patches fail, they may need updating for new dep versions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check patches/ directory against package.json patchedDependencies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Swift 6.2 / macOS 26 SDK Build Failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Symptoms:** Build fails with deprecation warnings about `FileManager.default` or `Thread.isMainThread`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Search-Mode Investigation:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Exhaustive search for deprecated APIs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
morph-mcp_warpgrep_codebase_search search_string="Find all Swift files using deprecated FileManager.default or Thread.isMainThread" repo_path="/Volumes/Main SSD/Developer/clawdis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Quick Fix Commands:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Find all affected files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
find . -name "*.swift" -exec grep -l "FileManager\.default\|Thread\.isMainThread" {} \;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Replace FileManager.default with FileManager()（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
find . -name "*.swift" -exec sed -i '' 's/FileManager\.default/FileManager()/g' {} \;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# For Thread.isMainThread, need manual review of each usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grep -rn "Thread\.isMainThread" --include="*.swift" .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Rebuild After Fixes:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Clean all build artifacts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rm -rf apps/macos/.build apps/macos/.swiftpm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rm -rf src/canvas-host/a2ui/.build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Rebuild Peekaboo bundle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm canvas:a2ui:bundle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Full macOS rebuild（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./scripts/restart-mac.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Automation Script（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Save as `scripts/sync-upstream.sh`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#!/usr/bin/env bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
set -euo pipefail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Fetching upstream..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch upstream（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Current divergence:"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rev-list --left-right --count main...upstream/main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Rebasing onto upstream/main..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rebase upstream/main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Installing dependencies..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Building..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ui:build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Running doctor..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm clawdbot doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Rebuilding macOS app..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./scripts/restart-mac.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Verifying gateway health..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm clawdbot health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Checking for Swift 6.2 compatibility issues..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if grep -r "FileManager\.default\|Thread\.isMainThread" src/ apps/ --include="*.swift" --quiet; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    echo "⚠️  Found potential Swift 6.2 deprecated API usage"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    echo "   Run manual fixes or use analyze-mode investigation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    echo "✅ No obvious Swift deprecation issues found"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Testing agent functionality..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Note: Update YOUR_TELEGRAM_SESSION_ID with actual session ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm clawdbot agent --message "Verification: Upstream sync and macOS rebuild completed successfully." --session-id YOUR_TELEGRAM_SESSION_ID || echo "Warning: Agent test failed - check Telegram for verification message"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "==> Done! Check Telegram for verification message, then run 'git push --force-with-lease' when ready."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
