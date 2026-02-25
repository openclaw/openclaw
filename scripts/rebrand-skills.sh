#!/usr/bin/env bash
# Rebrand: Activi → Activi
# Durchsucht das gesamte Repo und externe Skills-Verzeichnisse

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Modus: --skills-only oder --full (default: --full)
MODE="${1:---full}"

SKILLS_DIRS=(
  "$REPO_ROOT/skills"
  "$REPO_ROOT/extensions"
  "$HOME/.activi/skills"
  "$HOME/.activi/skills"
)

FULL_DIRS=(
  "$REPO_ROOT"
)

# Verzeichnisse die ausgeschlossen werden
EXCLUDE_DIRS=(
  "node_modules"
  ".git"
  "dist"
  "build"
  ".next"
  ".turbo"
  ".cache"
)

# Branding-Mappings
declare -A BRANDING_MAP=(
  ["Activi"]="Activi"
  ["activi"]="activi"
  ["ACTIVI"]="ACTIVI"
  ["activi"]="activi"
  ["Activi"]="Activi"
  ["activi.ai"]="activi.ai"
  ["activi.com"]="activi.com"
  ["docs.activi.ai"]="docs.activi.ai"
  ["activihub.com"]="activihub.com"
  ["ActiviHub"]="ActiviHub"
  ["activihub"]="activihub"
  ["ACTIVI"]="ACTIVI"
  ["ACTIVI_TMUX_SOCKET_DIR"]="ACTIVI_TMUX_SOCKET_DIR"
  [.activi"]="activi"
  ["Activi"]="Activi"
  [".activi"]=".activi"
  ["/data/.activi"]="/data/.activi"
  [".activi"]=".activi"
  ["/data/.activi"]="/data/.activi"
  ["~/activi"]="~/.activi"
  ["activi"]="activi"
  ["ACTIVIHUB_REGISTRY"]="ACTIVIHUB_REGISTRY"
  ["ACTIVIHUB_WORKDIR"]="ACTIVIHUB_WORKDIR"
)

# Dateien die durchsucht werden sollen
FILE_PATTERNS=(
  "*.md"
  "*.json"
  "*.sh"
  "*.py"
  "*.ts"
  "*.js"
  "*.txt"
  "*.yaml"
  "*.yml"
  "*.toml"
  "*.cfg"
  "*.env"
  "*.xml"
  "*.html"
  "*.css"
  "*.scss"
  "*.dockerfile"
  "Dockerfile"
  "docker-compose*.yml"
  "*.lock"
)

# Funktion: Rebrand eine Datei
rebrand_file() {
  local file="$1"
  local temp_file="${file}.rebrand.tmp"
  
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  
  # Kopiere Datei
  cp "$file" "$temp_file"
  
  # Ersetze alle Branding-Referenzen
  for old_brand in "${!BRANDING_MAP[@]}"; do
    new_brand="${BRANDING_MAP[$old_brand]}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
      # macOS sed
      sed -i '' "s|${old_brand}|${new_brand}|g" "$temp_file"
    else
      # Linux sed
      sed -i "s|${old_brand}|${new_brand}|g" "$temp_file"
    fi
  done
  
  # Prüfe ob Änderungen gemacht wurden
  if ! diff -q "$file" "$temp_file" > /dev/null 2>&1; then
    mv "$temp_file" "$file"
    echo "✓ Rebranded: $file"
    return 0
  else
    rm "$temp_file"
    return 1
  fi
}

# Funktion: Build find exclude args
build_exclude_args() {
  local args=""
  for exc in "${EXCLUDE_DIRS[@]}"; do
    args="$args -path '*/${exc}' -prune -o -path '*/${exc}/*' -prune -o"
  done
  echo "$args"
}

# Funktion: Rebrand ein Verzeichnis (rekursiv, alle Unterordner)
rebrand_directory() {
  local dir="$1"
  local count=0

  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  echo "Scanning: $dir"

  # Durchsuche ALLE Dateien rekursiv, mit Ausschluss-Verzeichnissen
  while IFS= read -r -d '' file; do
    if rebrand_file "$file"; then
      ((count++)) || true
    fi
  done < <(find "$dir" \
    -path "*/node_modules" -prune -o \
    -path "*/.git" -prune -o \
    -path "*/dist" -prune -o \
    -path "*/build" -prune -o \
    -path "*/.next" -prune -o \
    -path "*/.turbo" -prune -o \
    -path "*/.cache" -prune -o \
    -type f \( \
      -name "*.md" -o \
      -name "*.json" -o \
      -name "*.sh" -o \
      -name "*.py" -o \
      -name "*.ts" -o \
      -name "*.js" -o \
      -name "*.txt" -o \
      -name "*.yaml" -o \
      -name "*.yml" -o \
      -name "*.toml" -o \
      -name "*.cfg" -o \
      -name "*.env" -o \
      -name "*.xml" -o \
      -name "*.html" -o \
      -name "*.css" -o \
      -name "*.scss" -o \
      -name "Dockerfile" -o \
      -name "docker-compose*.yml" \
    \) -print0 2>/dev/null || true)

  echo "  → $count files rebranded in $dir"

  # Verzeichnisse mit altem Branding melden
  while IFS= read -r subdir; do
    if [[ -n "$subdir" ]]; then
      echo "  ⚠️  Directory with old branding: $subdir"
    fi
  done < <(find "$dir" \
    -path "*/node_modules" -prune -o \
    -path "*/.git" -prune -o \
    -type d \( -name "*activi*" -o -name "*activihub*" \) -print 2>/dev/null || true)

  [[ $count -gt 0 ]] && return 0 || return 1
}

# Hauptfunktion
main() {
  local total_changed=0

  if [[ "$MODE" == "--skills-only" ]]; then
    echo "🔄 Rebranding (skills only): Activi → Activi"
    echo ""
    SCAN_DIRS=("${SKILLS_DIRS[@]}")
  else
    echo "🔄 Full Rebranding: Activi → Activi"
    echo "   Scope: entire repo + external skills"
    echo ""
    SCAN_DIRS=("${FULL_DIRS[@]}" "$HOME/.activi/skills" "$HOME/.activi/skills")
  fi

  for dir_pattern in "${SCAN_DIRS[@]}"; do
    for dir in $dir_pattern; do
      if [[ -d "$dir" ]]; then
        if rebrand_directory "$dir"; then
          total_changed=1
        fi
      fi
    done
  done

  echo ""
  if [[ $total_changed -eq 1 ]]; then
    echo "✅ Rebranding completed. Files were modified."
    echo ""
    echo "⚠️  Please review the changes before committing:"
    echo "   git diff"
  else
    echo "ℹ️  No changes needed. Everything is already rebranded."
  fi
}

main "$@"
