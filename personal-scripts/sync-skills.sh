#!/bin/bash
# Sync clawd workspace: pull upstream + merge + push changes
# No longer syncs to ~/.clawd - everything lives in ~/clawd

cd /Users/steve/clawd

UPSTREAM_CHANGES=0
LOCAL_CHANGES=0

# 1. Pull latest from upstream moltbot
echo "Fetching upstream..."
git fetch upstream 2>/dev/null

UPSTREAM_COUNT=$(git log HEAD..upstream/main --oneline 2>/dev/null | wc -l | tr -d ' ')
if [ "$UPSTREAM_COUNT" -gt 0 ]; then
    echo "Merging $UPSTREAM_COUNT upstream changes..."
    UPSTREAM_CHANGES=1
    git merge upstream/main -m "Auto-merge upstream moltbot" --no-edit || {
        # Keep LOCAL versions for personalized workspace files
        git checkout --ours .gitignore AGENTS.md SOUL.md USER.md IDENTITY.md TOOLS.md memory.md memory/ personal-scripts/ 2>/dev/null
        # Take UPSTREAM versions for skills (we want upstream improvements)
        git checkout --theirs skills/ 2>/dev/null
        # Take UPSTREAM for project docs
        git checkout --theirs CHANGELOG.md README.md 2>/dev/null
        git add -A
        git commit -m "Auto-merge upstream (kept workspace files, took upstream skills/docs)" --no-edit
    }
fi

# 2. Rebuild dist if upstream changed (plugin SDK exports, etc.)
if [ "$UPSTREAM_CHANGES" -eq 1 ]; then
    echo "Rebuilding dist..."
    npm run build 2>&1 | tail -3
    BUILD_EXIT=$?
    if [ "$BUILD_EXIT" -ne 0 ]; then
        echo "⚠️ Build failed (exit $BUILD_EXIT), installing deps and retrying..."
        npm install --legacy-peer-deps 2>&1 | tail -3
        npm run build 2>&1 | tail -3
    fi
fi

# 3. Commit any local changes (including rebuilt dist)
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Committing local changes..."
    LOCAL_CHANGES=1
    git add -A
    git commit -m "Auto-sync: $(date '+%Y-%m-%d %H:%M')"
fi

# 4. Push everything
if [ "$UPSTREAM_CHANGES" -eq 1 ] || [ "$LOCAL_CHANGES" -eq 1 ]; then
    echo "Pushing to origin..."
    git push origin main
fi

# 5. Build status message
STATUS=""
if [ "$UPSTREAM_CHANGES" -eq 1 ]; then
    STATUS="🔄 Synced $UPSTREAM_COUNT commits from upstream"
elif [ "$LOCAL_CHANGES" -eq 1 ]; then
    STATUS="✅ Pushed local changes"
else
    STATUS="✅ sync-skills: already up to date"
fi

echo "$STATUS"

# 6. Notify via Telegram (if moltbot available and gateway running)
MOLTBOT="/Users/steve/Library/pnpm/moltbot"
if [ -x "$MOLTBOT" ] && lsof -i :18789 >/dev/null 2>&1; then
    "$MOLTBOT" agent --agent main --message "$STATUS" --deliver --reply-channel telegram --reply-account steve --reply-to 1191367022 2>&1 || true
fi
