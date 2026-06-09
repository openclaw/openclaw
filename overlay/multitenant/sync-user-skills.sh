#!/usr/bin/env bash
# Materialize the tenant's web-authored private skills into the on-disk layout
# the agent loads (Phase A, S2 — the user-skill -> runtime delivery).
#
# A user writes a private skill in the web UI; it is stored per-user in
# platform-context (`user_skill` table, migration 39). This script fetches
# those skills and writes each as:
#     ~/.claude/skills/<name>/SKILL.md   (+ commands/<name>.md slash-command stub)
#     ~/.codex/skills/<name>/SKILL.md    (+ commands/<name>.md)
# mirroring overlay/multitenant/assemble-skills.sh (platform-global skills) and
# hydrate_platform_home_bundle in entrypoint.sh.
#
# WHY directory-based: the runtime skill loader is directory-based + static
# (platform-runtime/src/agents/skills/workspace.ts:loadWorkspaceSkillEntries).
#   - subscription mode runs the OFFICIAL claude/codex binaries, which
#     auto-discover ~/.claude/skills/<name>/SKILL.md directly — no OpenClaw
#     config filter applies.
#   - byok/open-weights run the OpenClaw gateway, which loads the same
#     ~/.claude/skills dir (OPENCLAW_SKILLS_DIR) as the workspace/managed
#     skills dir. The entrypoint-seeded ~/.openclaw/openclaw.json sets NO
#     `agents.defaults.skills` allowlist, so the effective skill filter is
#     undefined == allow-all (resolveEffectiveAgentSkillFilter); user skills
#     survive. If a future config adds an allowlist it MUST include user skill
#     names or they will be filtered out (config-filter reconciliation).
#
# WHEN it runs:
#   - once at container start (entrypoint.sh, after hydrate_platform_home_bundle)
#   - per chat session via the SessionStart hook in settings.json.j2, so a
#     just-authored skill appears WITHOUT a Fly machine restart.
#
# SCOPING: authenticates with the tenant-scoped X-Tenant-Token (no user
# identity in the runtime today). Today a tenant is rooted at a single user
# (platform-context User.derive_tenant_id_from_record), so ?scope=user returns
# that owner's skills. When tenants become multi-user (Phase B+), the runtime
# must pass the acting user; see the platform-context list_tenant_skills note.
#
# Best-effort by design: any failure (offline control plane, 401, malformed
# JSON) logs a WARN and leaves previously-synced skills in place. A chat turn
# must never be blocked by a user-skill sync failure.

set -uo pipefail

log() { printf '[sync-user-skills] %s\n' "$*" >&2; }

API_BASE="${ROCKIELAB_API_BASE:-https://api.rockielab.com}"
API_BASE="${API_BASE%/}"
TENANT_ID="${ROCKIELAB_TENANT_ID:-}"
TENANT_TOKEN="${ROCKIELAB_TENANT_TOKEN:-${ROCKIELAB_TENANT_DEV_TOKEN:-}}"
RUNTIME_USER_AGENT="rockie-runtime/1.0 (+https://api.rockielab.com)"
HOME_DIR="${HOME:-/home/runtime}"
CLAUDE_SKILLS="${OPENCLAW_SKILLS_DIR:-$HOME_DIR/.claude/skills}"
CLAUDE_COMMANDS="$(dirname "$CLAUDE_SKILLS")/commands"
CODEX_SKILLS="$HOME_DIR/.codex/skills"
CODEX_COMMANDS="$HOME_DIR/.codex/commands"
# Marker dir tracking which skills WE wrote, so a deleted skill is pruned on the
# next sync without ever touching a tenant- or platform-authored sibling skill.
STATE_DIR="$HOME_DIR/.rockie/user-skills"

if [ -z "$TENANT_ID" ]; then
  log "WARN: ROCKIELAB_TENANT_ID unset; skipping user-skill sync"
  exit 0
fi
if [ -z "$TENANT_TOKEN" ]; then
  log "WARN: tenant token unset; skipping user-skill sync (would 401)"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  log "WARN: jq not present; cannot parse user-skill payload; skipping"
  exit 0
fi

mkdir -p "$STATE_DIR"

# Fetch only the private (scope=user) skills.
RESP="$(curl -fsS --max-time 15 \
  -H "User-Agent: ${RUNTIME_USER_AGENT}" \
  -H "X-Tenant-Token: ${TENANT_TOKEN}" \
  -H "X-Tenant-Id: ${TENANT_ID}" \
  "${API_BASE}/api/skills?scope=user" 2>/dev/null)" || {
  log "WARN: GET ${API_BASE}/api/skills?scope=user failed; leaving existing user skills in place"
  exit 0
}

if ! printf '%s' "$RESP" | jq -e '.skills' >/dev/null 2>&1; then
  log "WARN: response missing .skills array; skipping"
  exit 0
fi

# Names present in this fetch — used to prune skills the user deleted.
PRESENT_NAMES="$(printf '%s' "$RESP" | jq -r '.skills[]?.name // empty')"

# A user skill name is a validated slug server-side (^[a-z][a-z0-9-]{0,63}$),
# but re-validate here so a compromised/garbage name can never escape the
# skills dir via path traversal.
valid_name() { printf '%s' "$1" | grep -Eq '^[a-z][a-z0-9-]{0,63}$'; }

write_skill() {
  local name="$1" body="$2" skills_root="$3" commands_root="$4"
  local skill_dir="$skills_root/$name"
  mkdir -p "$skill_dir" "$commands_root"
  printf '%s' "$body" > "$skill_dir/SKILL.md"
  cat > "$commands_root/$name.md" <<EOF
---
description: Run the $name private skill.
---

Invoke the \`$name\` skill (see $skills_root/$name/SKILL.md) with the
arguments below.

\$ARGUMENTS
EOF
}

count=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if ! valid_name "$name"; then
    log "WARN: skipping skill with invalid name: $(printf '%q' "$name")"
    continue
  fi
  body="$(printf '%s' "$RESP" | jq -r --arg n "$name" \
    '.skills[] | select(.name == $n) | .body // ""')"
  # A user skill with an empty body still needs a minimal SKILL.md with
  # frontmatter so the loader registers it (name + description discovery).
  if [ -z "$body" ]; then
    desc="$(printf '%s' "$RESP" | jq -r --arg n "$name" \
      '.skills[] | select(.name == $n) | .description // ""')"
    body="$(printf -- '---\nname: %s\ndescription: %s\n---\n' "$name" "$desc")"
  fi
  write_skill "$name" "$body" "$CLAUDE_SKILLS" "$CLAUDE_COMMANDS"
  write_skill "$name" "$body" "$CODEX_SKILLS" "$CODEX_COMMANDS"
  touch "$STATE_DIR/$name"
  count=$((count + 1))
done <<< "$PRESENT_NAMES"

# Prune: any skill WE previously wrote (tracked in STATE_DIR) that is no longer
# present in the fetch was deleted by the user — remove our copies. We never
# touch a skill we didn't write (no marker file), so platform/tenant siblings
# are safe.
if [ -d "$STATE_DIR" ]; then
  for marker in "$STATE_DIR"/*; do
    [ -e "$marker" ] || continue
    pname="$(basename "$marker")"
    if ! printf '%s\n' "$PRESENT_NAMES" | grep -qxF "$pname"; then
      log "pruning deleted user skill: $pname"
      rm -rf "$CLAUDE_SKILLS/$pname" "$CODEX_SKILLS/$pname"
      rm -f "$CLAUDE_COMMANDS/$pname.md" "$CODEX_COMMANDS/$pname.md"
      rm -f "$marker"
    fi
  done
fi

log "synced ${count} user skill(s) for tenant ${TENANT_ID} into ${CLAUDE_SKILLS}"
exit 0
