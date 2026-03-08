#!/usr/bin/env bash
# openclaw-skills-audit — Scan installed skills for security risks
# Prototype for Phase 1 of RFC #10890
# Author: Clay (@theMachineClay) & Ivy Fei
# License: MIT

set -euo pipefail

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Defaults
VERBOSE=0
JSON_OUTPUT=0
SKILL_DIRS=()

usage() {
  cat <<EOF
Usage: skills-audit [OPTIONS] [SKILL_DIR ...]

Scan OpenClaw skills for security risks.

Options:
  -v, --verbose     Show detailed findings per skill
  -j, --json        Output JSON instead of table
  -h, --help        Show this help

If no SKILL_DIR is given, scans the default OpenClaw skill locations:
  - Bundled: /opt/homebrew/lib/node_modules/openclaw/skills (macOS brew)
  - Bundled: /usr/lib/node_modules/openclaw/skills (Linux global)
  - Workspace: ~/.openclaw/workspace/skills
  - ClawHub: ~/.openclaw/skills

EOF
}

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    -v|--verbose) VERBOSE=1; shift ;;
    -j|--json) JSON_OUTPUT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) SKILL_DIRS+=("$1"); shift ;;
  esac
done

# Default skill directories
if [[ ${#SKILL_DIRS[@]} -eq 0 ]]; then
  for d in \
    "/opt/homebrew/lib/node_modules/openclaw/skills" \
    "/usr/lib/node_modules/openclaw/skills" \
    "$HOME/.openclaw/workspace/skills" \
    "$HOME/.openclaw/skills"; do
    [[ -d "$d" ]] && SKILL_DIRS+=("$d")
  done
fi

if [[ ${#SKILL_DIRS[@]} -eq 0 ]]; then
  echo "No skill directories found."
  exit 1
fi

# Risk patterns in SKILL.md content
DANGEROUS_TOOL_PATTERNS=(
  'exec'
  'browser'
  'web_fetch'
  'web_search'
  'gateway'
  'nodes'
  'cron'
  'message'
)

SENSITIVE_PATH_PATTERNS=(
  '~/\.ssh'
  '~/\.aws'
  '~/\.env'
  '~/\.gnupg'
  '~/\.gitconfig'
  'id_rsa'
  'private\.key'
  'credentials\.json'
  'secret\.key'
)

EXFIL_PATTERNS=(
  'curl.*POST'
  'wget.*--post'
  'requests\.post'
  'fetch\('
  'webhook'
  'ngrok'
  'burp'
  'evil'
  'exfil'
  'base64.*encode'
)

# Counters
total_skills=0
total_executables=0
total_high=0
total_medium=0
total_low=0
total_clean=0
total_no_manifest=0

# JSON array
json_results="["

scan_skill() {
  local skill_dir="$1"
  local skill_name
  skill_name=$(basename "$skill_dir")
  local skill_md="$skill_dir/SKILL.md"
  local risk_level="clean"
  local findings=()
  local tools_referenced=()
  local has_executables=0
  local has_sensitive_paths=0
  local has_exfil_patterns=0
  local has_permission_manifest=0
  local executable_files=()

  total_skills=$((total_skills + 1))

  # Check for SKILL.md
  if [[ ! -f "$skill_md" ]]; then
    findings+=("⚠️  No SKILL.md found")
    risk_level="medium"
  fi

  # Check for permission manifest
  if [[ -f "$skill_dir/permissions.json" ]] || [[ -f "$skill_dir/permissions.yaml" ]] || [[ -f "$skill_dir/skill.json" ]]; then
    has_permission_manifest=1
  fi

  # Scan for executables
  while IFS= read -r -d '' f; do
    executable_files+=("$(basename "$f")")
    has_executables=1
    total_executables=$((total_executables + 1))
  done < <(find "$skill_dir" -type f \( -name "*.sh" -o -name "*.py" -o -name "*.js" -o -name "*.rb" -o -name "*.go" \) -not -path "*/node_modules/*" -print0 2>/dev/null)

  if [[ $has_executables -eq 1 ]]; then
    findings+=("📦 Contains executables: ${executable_files[*]}")
    [[ "$risk_level" == "clean" ]] && risk_level="low"
  fi

  # Scan SKILL.md for tool references
  if [[ -f "$skill_md" ]]; then
    local content
    content=$(cat "$skill_md")

    for pattern in "${DANGEROUS_TOOL_PATTERNS[@]}"; do
      if echo "$content" | grep -qi "\b${pattern}\b"; then
        tools_referenced+=("$pattern")
      fi
    done

    if [[ ${#tools_referenced[@]} -gt 0 ]]; then
      findings+=("🔧 Tools referenced: ${tools_referenced[*]}")
      # exec + browser + network = high risk combo
      if [[ " ${tools_referenced[*]} " =~ " exec " ]] && [[ " ${tools_referenced[*]} " =~ " web_fetch " || " ${tools_referenced[*]} " =~ " browser " ]]; then
        risk_level="high"
      elif [[ " ${tools_referenced[*]} " =~ " exec " ]]; then
        [[ "$risk_level" != "high" ]] && risk_level="medium"
      fi
    fi
  fi

  # Scan executable files (not docs) for sensitive path access
  while IFS= read -r -d '' f; do
    for pattern in "${SENSITIVE_PATH_PATTERNS[@]}"; do
      if grep -qiE "$pattern" "$f" 2>/dev/null; then
        has_sensitive_paths=1
        break 2
      fi
    done
  done < <(find "$skill_dir" -type f \( -name "*.sh" -o -name "*.py" -o -name "*.js" -o -name "*.rb" -o -name "*.go" \) -not -path "*/node_modules/*" -print0 2>/dev/null)

  if [[ $has_sensitive_paths -eq 1 ]]; then
    findings+=("🔑 References sensitive paths (credentials, keys, tokens)")
    [[ "$risk_level" != "high" ]] && risk_level="medium"
  fi

  # Scan executables for exfiltration patterns
  if [[ $has_executables -eq 1 ]]; then
    while IFS= read -r -d '' f; do
      for pattern in "${EXFIL_PATTERNS[@]}"; do
        if grep -qiE "$pattern" "$f" 2>/dev/null; then
          has_exfil_patterns=1
          findings+=("🚨 Potential exfiltration pattern in $(basename "$f"): matches '$pattern'")
          risk_level="high"
          break
        fi
      done
    done < <(find "$skill_dir" -type f \( -name "*.sh" -o -name "*.py" -o -name "*.js" \) -not -path "*/node_modules/*" -print0 2>/dev/null)
  fi

  # No permission manifest
  if [[ $has_permission_manifest -eq 0 ]]; then
    findings+=("📋 No permission manifest found")
    total_no_manifest=$((total_no_manifest + 1))
  fi

  # Compute hash of SKILL.md for integrity tracking
  local skill_hash="n/a"
  if [[ -f "$skill_md" ]]; then
    skill_hash=$(shasum -a 256 "$skill_md" | cut -d' ' -f1 | head -c 12)
  fi

  # Update counters
  case "$risk_level" in
    high) total_high=$((total_high + 1)) ;;
    medium) total_medium=$((total_medium + 1)) ;;
    low) total_low=$((total_low + 1)) ;;
    clean) total_clean=$((total_clean + 1)) ;;
  esac

  # Output
  if [[ $JSON_OUTPUT -eq 1 ]]; then
    local tools_json="[]"
    if [[ ${#tools_referenced[@]} -gt 0 ]]; then
      tools_json=$(printf '%s\n' "${tools_referenced[@]}" | jq -R . | jq -s .)
    fi
    local execs_json="[]"
    if [[ ${#executable_files[@]} -gt 0 ]]; then
      execs_json=$(printf '%s\n' "${executable_files[@]}" | jq -R . | jq -s .)
    fi
    local findings_json="[]"
    if [[ ${#findings[@]} -gt 0 ]]; then
      findings_json=$(printf '%s\n' "${findings[@]}" | jq -R . | jq -s .)
    fi

    [[ "$json_results" != "[" ]] && json_results+=","
    json_results+=$(jq -n \
      --arg name "$skill_name" \
      --arg risk "$risk_level" \
      --arg hash "$skill_hash" \
      --argjson has_manifest "$( [[ $has_permission_manifest -eq 1 ]] && echo true || echo false )" \
      --argjson tools "$tools_json" \
      --argjson executables "$execs_json" \
      --argjson findings "$findings_json" \
      '{name: $name, risk: $risk, hash: $hash, has_manifest: $has_manifest, tools: $tools, executables: $executables, findings: $findings}')
  else
    # Table row
    local risk_color
    case "$risk_level" in
      high) risk_color="$RED" ;;
      medium) risk_color="$YELLOW" ;;
      low) risk_color="$CYAN" ;;
      clean) risk_color="$GREEN" ;;
    esac

    local manifest_icon
    [[ $has_permission_manifest -eq 1 ]] && manifest_icon="✅" || manifest_icon="❌"

    printf "  ${risk_color}%-8s${NC} %-28s %-14s %s  %s\n" \
      "[$risk_level]" "$skill_name" "$skill_hash" "$manifest_icon" \
      "$(IFS=,; echo "${tools_referenced[*]:-none}")"

    if [[ $VERBOSE -eq 1 ]] && [[ ${#findings[@]} -gt 0 ]]; then
      for finding in "${findings[@]}"; do
        printf "           ${DIM}%s${NC}\n" "$finding"
      done
      echo ""
    fi
  fi
}

# Header
if [[ $JSON_OUTPUT -eq 0 ]]; then
  echo ""
  echo -e "${BOLD}🦞 OpenClaw Skills Audit${NC}"
  echo -e "${DIM}Phase 1 prototype — RFC #10890${NC}"
  echo ""
  printf "  ${BOLD}%-8s %-28s %-14s %s  %s${NC}\n" "RISK" "SKILL" "HASH" "MANIFEST" "TOOLS"
  echo "  ─────────────────────────────────────────────────────────────────────────────"
fi

# Scan all skill directories
for dir in "${SKILL_DIRS[@]}"; do
  if [[ $JSON_OUTPUT -eq 0 ]]; then
    echo -e "\n  ${DIM}📂 $dir${NC}"
  fi
  for skill in "$dir"/*/; do
    [[ -d "$skill" ]] && scan_skill "$skill"
  done
done

# Footer
if [[ $JSON_OUTPUT -eq 1 ]]; then
  json_results+="]"
  echo "$json_results" | jq .
else
  echo ""
  echo "  ─────────────────────────────────────────────────────────────────────────────"
  echo -e "  ${BOLD}Summary:${NC} $total_skills skills scanned"
  echo -e "    ${RED}🔴 High:${NC}   $total_high"
  echo -e "    ${YELLOW}🟡 Medium:${NC} $total_medium"
  echo -e "    ${CYAN}🔵 Low:${NC}    $total_low"
  echo -e "    ${GREEN}🟢 Clean:${NC}  $total_clean"
  echo -e "    📦 Executables found: $total_executables"
  echo ""
  if [[ $total_high -gt 0 ]]; then
    echo -e "  ${RED}${BOLD}⚠️  $total_high high-risk skill(s) detected. Review before use.${NC}"
  fi
  if [[ $total_no_manifest -gt 0 ]]; then
    echo -e "  ${YELLOW}📋 ${total_no_manifest} skill(s) have no permission manifest.${NC}"
  fi
  echo ""
  echo -e "  ${DIM}Tip: Run with -v for detailed findings, -j for JSON output.${NC}"
  echo ""
fi
