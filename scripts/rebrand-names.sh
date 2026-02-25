#!/usr/bin/env bash
# Rebrand file/directory NAMES: OpenClaw → Activi
# Only renames the basename (leaf), keeps parent path intact
# Processes bottom-up to avoid breaking paths

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN="${1:---execute}"
RENAMED_COUNT=0
FAILED_COUNT=0

safe_rename() {
  local old_path="$1"
  local new_path="$2"
  [[ ! -e "$old_path" ]] && return 0
  if [[ -e "$new_path" ]]; then
    echo "  - SKIP (exists): $(basename "$new_path")"
    return 0
  fi
  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    echo "  [DRY] $(basename "$old_path") -> $(basename "$new_path")  (in $(dirname "$old_path"))"
  else
    if mv "$old_path" "$new_path"; then
      echo "  + $(basename "$old_path") -> $(basename "$new_path")"
      ((RENAMED_COUNT++)) || true
    else
      echo "  ! FAILED: $old_path"
      ((FAILED_COUNT++)) || true
    fi
  fi
}

rebrand_name() {
  local name="$1"
  echo "$name" \
    | sed 's|OpenClawKitResources|ActiviKitResources|g' \
    | sed 's|OpenClawKit|ActiviKit|g' \
    | sed 's|OpenClawChatUI|ActiviChatUI|g' \
    | sed 's|OpenClawProtocolConstants|ActiviProtocolConstants|g' \
    | sed 's|OpenClawProtocol|ActiviProtocol|g' \
    | sed 's|OpenClawDiscovery|ActiviDiscovery|g' \
    | sed 's|OpenClawIPCTests|ActiviIPCTests|g' \
    | sed 's|OpenClawIPC|ActiviIPC|g' \
    | sed 's|OpenClawMacCLI|ActiviMacCLI|g' \
    | sed 's|OpenClawLogging|ActiviLogging|g' \
    | sed 's|OpenClawConfigFile|ActiviConfigFile|g' \
    | sed 's|OpenClawOAuthStore|ActiviOAuthStore|g' \
    | sed 's|OpenClawPaths|ActiviPaths|g' \
    | sed 's|OpenClawWatchApp|ActiviWatchApp|g' \
    | sed 's|OpenClawCanvasA2UIAction|ActiviCanvasA2UIAction|g' \
    | sed 's|OpenClawTheme|ActiviTheme|g' \
    | sed 's|OpenClawApp|ActiviApp|g' \
    | sed 's|OpenClaw|Activi|g' \
    | sed 's|openclaw|activi|g' \
    | sed 's|ClawHub|ActiviHub|g' \
    | sed 's|clawhub|activihub|g' \
    | sed 's|clawdbot|activi|g' \
    | sed 's|open-claw|activi|g'
}

rebrand_path() {
  local full_path="$1"
  local dir_part base_part new_base
  dir_part="$(dirname "$full_path")"
  base_part="$(basename "$full_path")"
  new_base="$(rebrand_name "$base_part")"
  echo "${dir_part}/${new_base}"
}

echo "Rebranding file/directory NAMES: OpenClaw -> Activi"
echo "Mode: $DRY_RUN"
echo ""

echo "=== Phase 1: Renaming FILES ==="
while IFS= read -r file; do
  new_file="$(rebrand_path "$file")"
  if [[ "$file" != "$new_file" ]]; then
    safe_rename "$file" "$new_file"
  fi
done < <(find "$REPO_ROOT" \
  -path "*/node_modules" -prune -o \
  -path "*/.git" -prune -o \
  -type f \( \
    -name "*openclaw*" -o -name "*OpenClaw*" -o \
    -name "*clawhub*" -o -name "*ClawHub*" -o \
    -name "*clawdbot*" -o -name "*open-claw*" \
  \) -print 2>/dev/null | awk -F'/' '{print NF, $0}' | sort -rnk1 | cut -d' ' -f2-)

echo ""
echo "=== Phase 2: Renaming DIRECTORIES ==="
while IFS= read -r dir; do
  if [[ "$dir" == "$REPO_ROOT" ]]; then
    echo "  - SKIP repo root: $dir"
    continue
  fi
  new_dir="$(rebrand_path "$dir")"
  if [[ "$dir" != "$new_dir" ]]; then
    safe_rename "$dir" "$new_dir"
  fi
done < <(find "$REPO_ROOT" \
  -path "*/node_modules" -prune -o \
  -path "*/.git" -prune -o \
  -type d \( \
    -name "*openclaw*" -o -name "*OpenClaw*" -o \
    -name "*clawhub*" -o -name "*ClawHub*" -o \
    -name "*clawdbot*" -o -name "*open-claw*" \
  \) -print 2>/dev/null | awk -F'/' '{print NF, $0}' | sort -rnk1 | cut -d' ' -f2-)

echo ""
echo "=== Phase 3: Updating references to renamed files ==="

if [[ "$DRY_RUN" != "--dry-run" ]]; then
  declare -A REF_MAP=(
    ["activi.plugin.json"]="activi.plugin.json"
    ["activi.mjs"]="activi.mjs"
    ["activi.podman.env"]="activi.podman.env"
    ["activi-logo-text-dark.png"]="activi-logo-text-dark.png"
    ["activi-logo-text.png"]="activi-logo-text.png"
    ["activi-mac.png"]="activi-mac.png"
    ["whatsapp-activi-ai-zh.jpg"]="whatsapp-activi-ai-zh.jpg"
    ["whatsapp-activi.jpg"]="whatsapp-activi.jpg"
    ["activi-root"]="activi-root"
    ["tmp-activi-dir"]="tmp-activi-dir"
    ["activi-tools"]="activi-tools"
    ["activi-gateway-tool"]="activi-gateway-tool"
    ["types.activi"]="types.activi"
    ["run-activi-podman"]="run-activi-podman"
    ["activi-auth-monitor"]="activi-auth-monitor"
    ["activi.container"]="activi.container"
    ["update_activi"]="update_activi"
    ["Activi.entitlements"]="Activi.entitlements"
    ["Activi.icns"]="Activi.icns"
    ["ProcessInfo+Activi"]="ProcessInfo+Activi"
  )

  ref_count=0
  for old_ref in "${!REF_MAP[@]}"; do
    new_ref="${REF_MAP[$old_ref]}"
    [[ "$old_ref" == "$new_ref" ]] && continue
    while IFS= read -r file; do
      if [[ -f "$file" ]]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
          sed -i '' "s|${old_ref}|${new_ref}|g" "$file"
        else
          sed -i "s|${old_ref}|${new_ref}|g" "$file"
        fi
        ((ref_count++)) || true
      fi
    done < <(grep -rl "$old_ref" "$REPO_ROOT" \
      --include="*.ts" --include="*.js" --include="*.json" \
      --include="*.md" --include="*.sh" --include="*.yaml" \
      --include="*.yml" --include="*.swift" --include="*.kt" \
      --include="*.html" --include="*.css" --include="*.toml" \
      --include="*.env" --include="*.service" --include="*.timer" \
      --include="Dockerfile" --include="*.in" \
      2>/dev/null | grep -v node_modules | grep -v ".git/" || true)
  done
  echo "  Updated references in $ref_count files"
else
  echo "  [DRY] Skipping reference updates"
fi

echo ""
echo "============================================"
echo "Renamed: $RENAMED_COUNT | Failed: $FAILED_COUNT"
echo ""

remaining=$(find "$REPO_ROOT" \
  -path "*/node_modules" -prune -o \
  -path "*/.git" -prune -o \
  \( -name "*openclaw*" -o -name "*OpenClaw*" -o -name "*clawhub*" -o -name "*ClawHub*" -o -name "*clawdbot*" \) \
  -not -path "$REPO_ROOT" \
  -print 2>/dev/null | wc -l | tr -d ' ')

if [[ "$remaining" -gt 0 ]]; then
  echo "WARNING: $remaining items still with old branding:"
  find "$REPO_ROOT" \
    -path "*/node_modules" -prune -o \
    -path "*/.git" -prune -o \
    \( -name "*openclaw*" -o -name "*OpenClaw*" -o -name "*clawhub*" -o -name "*ClawHub*" -o -name "*clawdbot*" \) \
    -not -path "$REPO_ROOT" \
    -print 2>/dev/null
else
  echo "All clean - no remaining items with old branding."
fi
