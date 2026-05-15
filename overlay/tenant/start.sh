#!/usr/bin/env bash
# Bring up a tenant of platform-runtime.
#
# Inputs (env vars, all required):
#   TENANT_NAME         e.g. "alice", "team-foo"
#   TENANT_PORT         tcp port for openclaw gateway
#   TENANT_HOME         per-tenant home dir (will contain workspace, hooks, skills)
#
# What this does:
#   1. Clones / pulls platform-skills into $TENANT_HOME/skills/
#   2. Initializes workflow.db
#   3. Symlinks hook handler dirs into the managed-hook discovery path
#   4. Renders openclaw config from the template
#   5. Starts `openclaw gateway` in the foreground (caller backgrounds via launchd/systemd)

set -euo pipefail

: "${TENANT_NAME:?TENANT_NAME is required}"
: "${TENANT_PORT:?TENANT_PORT is required}"
: "${TENANT_HOME:?TENANT_HOME is required}"

OVERLAY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC=$(python3 -c "import json,sys; print(json.load(open('$OVERLAY_DIR/config/default-skills-source.json'))['skills_repo'])")
SKILLS_BRANCH=$(python3 -c "import json,sys; print(json.load(open('$OVERLAY_DIR/config/default-skills-source.json'))['branch'])")

WORKSPACE_DIR="$TENANT_HOME/workspace"
HOOKS_DIR="$TENANT_HOME/hooks-managed"
SKILLS_DIR="$TENANT_HOME/skills"
LOG_DIR="$TENANT_HOME/logs"

mkdir -p "$WORKSPACE_DIR/memory" "$HOOKS_DIR" "$LOG_DIR"

# 1. Sync platform-skills
if [ -d "$SKILLS_DIR/.git" ]; then
  git -C "$SKILLS_DIR" fetch origin "$SKILLS_BRANCH" --quiet
  git -C "$SKILLS_DIR" reset --hard "origin/$SKILLS_BRANCH" --quiet
else
  git clone --branch "$SKILLS_BRANCH" --depth 50 "git@github.com:$SKILLS_SRC.git" "$SKILLS_DIR"
fi

# 2. Init workflow.db
bash "$SKILLS_DIR/memory/init_db.sh"

# 3. Symlink the four hook-handler dirs into the discovery path
for h in rockie-session-start rockie-stop rockie-message-received rockie-compact-before; do
  ln -snf "$SKILLS_DIR/hooks/handlers/$h" "$HOOKS_DIR/$h"
done

# 4. Render config
TPL="$OVERLAY_DIR/config/tenant-template/openclaw.json"
RENDERED="$TENANT_HOME/openclaw.json"
TENANT_WORKSPACE_DIR="$WORKSPACE_DIR" TENANT_LOG_DIR="$LOG_DIR" \
  envsubst < "$TPL" > "$RENDERED"

# 5. Start (foreground; launchd/systemd backgrounds it)
export OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR"
export OPENCLAW_SKILLS_DIR="$SKILLS_DIR/skills"
export PLATFORM_SKILLS_ROOT="$SKILLS_DIR"
# `openclaw gateway` has no --config flag; resolveGatewayConfigPath
# (src/config/paths.ts) reads OPENCLAW_CONFIG_PATH instead.
export OPENCLAW_CONFIG_PATH="$RENDERED"
exec openclaw gateway --port "$TENANT_PORT"
