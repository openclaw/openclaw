#!/usr/bin/env bash
# clawhub-safe-install.sh
# ========================
# Safe wrapper for `clawhub install` and `clawhub update`.
# Runs Cisco AI Skill Scanner after every install/update and blocks the skill
# if CRITICAL or HIGH findings are detected.
#
# Usage:
#   clawhub-safe-install.sh install <slug> [--version x.y.z] [...]
#   clawhub-safe-install.sh update <slug> [--version x.y.z] [...]
#   clawhub-safe-install.sh update --all [--force] [...]
#
# Environment:
#   OPENCLAW_STATE_DIR  — Override state directory (default: ~/.openclaw)
#   SCANNER_POLICY      — Override scanner policy file path
#   SKILLS_DIR          — Override skills directory path
#
# Exit codes:
#   0  — installed/updated and scan clean (MEDIUM and below only)
#   1  — scan found CRITICAL or HIGH findings → skill blocked/rolled back
#   2  — clawhub command failed
#   3  — skill-scanner not found or install failed

set -euo pipefail

# ── Resolve paths via env vars ────────────────────────────────────────────────
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
SKILLS_DIR="${SKILLS_DIR:-$STATE_DIR/workspace/skills}"
POLICY="${SCANNER_POLICY:-$STATE_DIR/workspace/.skill-scanner-policy.yaml}"

# ── Preflight ────────────────────────────────────────────────────────────────
if ! command -v clawhub >/dev/null 2>&1; then
  echo "❌ clawhub not found. Run: npm i -g clawhub" >&2
  exit 2
fi

if ! command -v pip >/dev/null 2>&1; then
  echo "❌ pip not found. Install Python pip to use the skill scanner." >&2
  exit 3
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: clawhub-safe-install.sh install|update <slug|--all> [...]" >&2
  exit 1
fi

# ── Auto-upgrade skill-scanner before every run ──────────────────────────────
echo "🔄 Checking for skill-scanner updates..."
BEFORE=$(pip show cisco-ai-skill-scanner 2>/dev/null | awk '/^Version:/{print $2}' || echo "none")
pip install --upgrade --quiet cisco-ai-skill-scanner 2>&1 | grep -v '^$' || true
AFTER=$(pip show cisco-ai-skill-scanner 2>/dev/null | awk '/^Version:/{print $2}' || echo "unknown")

if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "   ⬆️  Updated: $BEFORE → $AFTER"
else
  echo "   ✅ Already on latest: $AFTER"
fi

if ! command -v skill-scanner >/dev/null 2>&1; then
  echo "❌ skill-scanner not found after install attempt." >&2
  exit 3
fi

CMD="$1"; shift  # install | update

# ── Helpers ──────────────────────────────────────────────────────────────────
scan_skill() {
  local slug="$1"
  local skill_path="$SKILLS_DIR/$slug"

  if [[ ! -d "$skill_path" ]]; then
    echo "⚠️  Directory not found: $skill_path — skipping scan." >&2
    return 0
  fi

  echo ""
  echo "🔍 Scanning '$slug'..."

  local scan_args=( scan "$skill_path" --lenient --use-behavioral --format summary )
  if [[ -f "$POLICY" ]]; then
    scan_args+=( --policy "$POLICY" )
  fi

  local output
  output=$(skill-scanner "${scan_args[@]}" 2>&1)
  echo "$output"
  echo ""

  local crit high
  crit=$(echo "$output" | sed -n 's/^[[:space:]]*Critical:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  high=$(echo "$output" | sed -n 's/^[[:space:]]*High:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  crit="${crit:-0}"
  high="${high:-0}"

  if [[ "$crit" -gt 0 || "$high" -gt 0 ]]; then
    echo "🚨 BLOCKED — $crit CRITICAL, $high HIGH findings in '$slug'." >&2
    return 1
  fi

  echo "✅ '$slug' — clean."
  return 0
}

update_baseline() {
  local baseline_file="$STATE_DIR/.skills-baseline.sha256"
  echo "📋 Updating skills baseline..."
  if command -v sha256sum >/dev/null 2>&1; then
    find "$SKILLS_DIR" -type f -print0 | sort -z | xargs -0 sha256sum > "$baseline_file"
  else
    find "$SKILLS_DIR" -type f -print0 | sort -z | xargs -0 shasum -a 256 > "$baseline_file"
  fi
  local count
  count=$(wc -l < "$baseline_file")
  echo "   $count files baselined."
}

# ── Install ──────────────────────────────────────────────────────────────────
if [[ "$CMD" == "install" ]]; then
  if [[ $# -lt 1 ]]; then
    echo "Usage: clawhub-safe-install.sh install <slug> [...]" >&2
    exit 1
  fi
  SLUG="$1"; shift
  echo "📦 Installing: $SLUG ..."
  if ! clawhub install "$SLUG" "$@"; then
    echo "❌ clawhub install failed." >&2
    exit 2
  fi
  if ! scan_skill "$SLUG"; then
    echo "   Removing installed skill..." >&2
    rm -rf "${SKILLS_DIR:?}/$SLUG"
    echo "   ✅ Removed. Fix the findings before installing." >&2
    exit 1
  fi
  update_baseline

# ── Update single ────────────────────────────────────────────────────────────
elif [[ "$CMD" == "update" && "${1:-}" != "--all" ]]; then
  if [[ $# -lt 1 ]]; then
    echo "Usage: clawhub-safe-install.sh update <slug> [...]" >&2
    exit 1
  fi
  SLUG="$1"; shift

  # Snapshot current state for rollback
  BACKUP_DIR=$(mktemp -d "/tmp/clawhub-rollback-${SLUG}-XXXXXX")
  if [[ -d "$SKILLS_DIR/$SLUG" ]]; then
    cp -r "$SKILLS_DIR/$SLUG/." "$BACKUP_DIR/"
    echo "💾 Backup saved: $BACKUP_DIR"
  fi

  echo "🔄 Updating: $SLUG ..."
  if ! clawhub update "$SLUG" "$@"; then
    echo "❌ clawhub update failed." >&2
    rm -rf "$BACKUP_DIR"
    exit 2
  fi

  if ! scan_skill "$SLUG"; then
    if [[ -d "$BACKUP_DIR" && -n "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]]; then
      echo "   Rolling back to previous version..." >&2
      rm -rf "${SKILLS_DIR:?}/$SLUG"
      mkdir -p "$SKILLS_DIR/$SLUG"
      cp -r "$BACKUP_DIR/." "$SKILLS_DIR/$SLUG/"
      echo "   ✅ Rolled back. Previous version restored." >&2
    else
      echo "   No backup to restore — removing skill." >&2
      rm -rf "${SKILLS_DIR:?}/$SLUG"
    fi
    rm -rf "$BACKUP_DIR"
    exit 1
  fi

  rm -rf "$BACKUP_DIR"
  update_baseline

# ── Update --all ─────────────────────────────────────────────────────────────
elif [[ "$CMD" == "update" && "${1:-}" == "--all" ]]; then
  shift  # drop --all

  # Snapshot all current skills before bulk update
  BACKUP_ROOT=$(mktemp -d "/tmp/clawhub-rollback-all-XXXXXX")
  for skill_dir in "$SKILLS_DIR"/*/; do
    [[ -d "$skill_dir" ]] || continue
    slug=$(basename "$skill_dir")
    cp -r "$skill_dir" "$BACKUP_ROOT/$slug"
  done
  echo "💾 Full backup saved: $BACKUP_ROOT"

  echo "🔄 Updating all skills..."
  if ! clawhub update --all "$@"; then
    echo "❌ clawhub update --all failed." >&2
    rm -rf "$BACKUP_ROOT"
    exit 2
  fi

  # Scan each skill — collect failures
  FAILED=()
  for skill_dir in "$SKILLS_DIR"/*/; do
    [[ -d "$skill_dir" ]] || continue
    slug=$(basename "$skill_dir")
    if ! scan_skill "$slug"; then
      FAILED+=("$slug")
    fi
  done

  # Roll back any that failed
  if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo "" >&2
    echo "🚨 ${#FAILED[@]} skill(s) failed scan — rolling back:" >&2
    for slug in "${FAILED[@]}"; do
      echo "   ↩️  $slug" >&2
      rm -rf "${SKILLS_DIR:?}/$slug"
      if [[ -d "$BACKUP_ROOT/$slug" ]]; then
        cp -r "$BACKUP_ROOT/$slug" "$SKILLS_DIR/$slug"
        echo "      restored from backup" >&2
      fi
    done
    rm -rf "$BACKUP_ROOT"
    echo "" >&2
    echo "Clean skills were updated. Blocked skills are at their previous version." >&2
    update_baseline
    exit 1
  fi

  rm -rf "$BACKUP_ROOT"
  update_baseline
  echo ""
  echo "✅ All skills updated and scanned clean."

else
  echo "Usage: clawhub-safe-install.sh install|update <slug|--all> [...]" >&2
  exit 1
fi
