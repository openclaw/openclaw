#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/prj/util/bin"
ENTRY_PATH="$SCRIPT_DIR/dist/entry.js"
WRAPPER_PATH="$BIN_DIR/openclaw"
LAUNCHD_LABEL="ai.openclaw.gateway"

cd "$SCRIPT_DIR"

# Always sync from origin (fork). Upstream merges are handled by repo-mole.
echo "Syncing with origin..."
git fetch origin

# Detect origin's default branch
ORIGIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if [ -z "$ORIGIN_BRANCH" ]; then
    for candidate in main master; do
        if git show-ref --verify --quiet "refs/remotes/origin/$candidate"; then
            ORIGIN_BRANCH="$candidate"
            break
        fi
    done
    ORIGIN_BRANCH="${ORIGIN_BRANCH:-main}"
fi

git reset --hard "origin/$ORIGIN_BRANCH"
echo "Now at: $(git log -1 --oneline)"

# Check if daemon is running before build
DAEMON_WAS_RUNNING=false
if launchctl print "gui/$UID/$LAUNCHD_LABEL" &>/dev/null; then
    DAEMON_WAS_RUNNING=true
    echo "Daemon is running - will stop before build and restart after"
fi

# Stop daemon if running
if [ "$DAEMON_WAS_RUNNING" = true ]; then
    echo "Stopping daemon..."
    launchctl bootout "gui/$UID/$LAUNCHD_LABEL" 2>/dev/null || true
    sleep 1
fi

# Clean build artifacts for idempotent builds
echo "Cleaning dist/..."
rm -rf dist/

echo "Installing dependencies..."
pnpm install
pnpm dedupe

echo "Building..."
pnpm run build

# Verify build output exists
if [ ! -f "$ENTRY_PATH" ]; then
    echo "ERROR: Build failed - $ENTRY_PATH not found"
    exit 1
fi

# Ensure bin directory exists
mkdir -p "$BIN_DIR"

# Always rewrite wrapper so mtime reflects this build
cat > "$WRAPPER_PATH" << WRAPPER_EOF
#!/usr/bin/env bash
exec node "$ENTRY_PATH" "\$@"
WRAPPER_EOF

chmod +x "$WRAPPER_PATH"
echo "Created wrapper: $WRAPPER_PATH"

# Verify
echo ""
echo "Installed openclaw:"
"$WRAPPER_PATH" --version 2>&1

# Run security audit
echo ""
echo "Running security audit..."
"$WRAPPER_PATH" security audit --deep || true

# Restart daemon if it was running
if [ "$DAEMON_WAS_RUNNING" = true ]; then
    echo ""
    echo "Restarting daemon..."
    "$WRAPPER_PATH" daemon install --force

    # Wait for gateway to start
    echo "Waiting for gateway..."
    for i in {1..10}; do
        if launchctl print "gui/$UID/$LAUNCHD_LABEL" 2>/dev/null | grep -q "state = running"; then
            echo "Daemon restarted successfully"
            break
        fi
        sleep 1
    done

    echo ""
    "$WRAPPER_PATH" daemon status --no-probe || true
fi
