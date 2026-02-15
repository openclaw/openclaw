#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# docs-i18n-gemini.sh — Translate OpenClaw docs using Gemini
#
# Usage:
#   ./scripts/docs-i18n-gemini.sh [options]
#
# Options:
#   --lang LANG        Target language code (e.g. zh-TW, ja-JP)  [required]
#   --subdir DIR       Subdirectory under docs/ to translate     [default: all]
#   --model MODEL      Gemini model to use                       [default: gemini-2.5-flash]
#   --parallel N       Max parallel translations                 [default: 6]
#   --docs-root DIR    Path to docs/ directory                   [default: ./docs]
#   --ref-lang LANG    Reference translation language (e.g. zh-CN) [optional]
#   --force            Re-translate even if output file exists
#   --help             Show this help
#
# Prerequisites:
#   - gemini CLI installed and authenticated (brew install gemini-cli)
#   - Glossary at docs/.i18n/glossary.<LANG>.json (optional but recommended)
#
# Examples:
#   # Translate gateway/ section to Traditional Chinese
#   ./scripts/docs-i18n-gemini.sh --lang zh-TW --subdir gateway --ref-lang zh-CN
#
#   # Translate everything to Japanese
#   ./scripts/docs-i18n-gemini.sh --lang ja-JP --parallel 4
#
#   # Force re-translate a section
#   ./scripts/docs-i18n-gemini.sh --lang zh-TW --subdir start --force
# ─────────────────────────────────────────────────────────

LANG_CODE=""
SUBDIR=""
MODEL="gemini-2.5-flash"
MAX_PARALLEL=6
DOCS_ROOT="./docs"
REF_LANG=""
FORCE=false

usage() {
  sed -n '3,/^# ──/p' "$0" | head -n -1 | sed 's/^# \?//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang)       LANG_CODE="$2"; shift 2 ;;
    --subdir)     SUBDIR="$2"; shift 2 ;;
    --model)      MODEL="$2"; shift 2 ;;
    --parallel)   MAX_PARALLEL="$2"; shift 2 ;;
    --docs-root)  DOCS_ROOT="$2"; shift 2 ;;
    --ref-lang)   REF_LANG="$2"; shift 2 ;;
    --force)      FORCE=true; shift ;;
    --help|-h)    usage ;;
    *)            echo "Unknown option: $1"; usage ;;
  esac
done

if [[ -z "$LANG_CODE" ]]; then
  echo "Error: --lang is required"
  usage
fi

# Resolve paths
DOCS_ROOT="$(cd "$DOCS_ROOT" && pwd)"
EN_ROOT="$DOCS_ROOT"
OUT_ROOT="$DOCS_ROOT/$LANG_CODE"
GLOSSARY_FILE="$DOCS_ROOT/.i18n/glossary.${LANG_CODE}.json"
REF_ROOT=""
[[ -n "$REF_LANG" ]] && REF_ROOT="$DOCS_ROOT/$REF_LANG"

# Load glossary if available
GLOSSARY_TEXT=""
if [[ -f "$GLOSSARY_FILE" ]]; then
  GLOSSARY_TEXT=$(cat "$GLOSSARY_FILE")
  echo "Loaded glossary: $GLOSSARY_FILE"
else
  echo "No glossary found at $GLOSSARY_FILE (proceeding without)"
fi

# Language display names for the prompt
lang_display() {
  case "$1" in
    zh-TW) echo "Traditional Chinese (zh-TW), using terminology and phrasing natural to Taiwan" ;;
    zh-CN) echo "Simplified Chinese (zh-CN), using terminology common in mainland China" ;;
    ja-JP) echo "Japanese (ja-JP)" ;;
    ko-KR) echo "Korean (ko-KR)" ;;
    *)     echo "$1" ;;
  esac
}

TARGET_LANG_DESC=$(lang_display "$LANG_CODE")

translate_file() {
  local rel_path="$1"
  local en_file="$EN_ROOT/$rel_path"
  local out_file="$OUT_ROOT/${rel_path#*/}"  # strip first dir component if subdir

  # Reconstruct proper output path
  if [[ -n "$SUBDIR" ]]; then
    out_file="$OUT_ROOT/$rel_path"
  else
    out_file="$OUT_ROOT/$rel_path"
  fi

  # Skip translated locales, .i18n, and non-md files
  case "$rel_path" in
    zh-CN/*|zh-TW/*|ja-JP/*|ko-KR/*|.i18n/*) return 0 ;;
  esac

  # Skip if already translated (unless --force)
  if [[ "$FORCE" != "true" && -f "$out_file" ]]; then
    echo "SKIP: $rel_path"
    return 0
  fi

  # Ensure output directory exists
  mkdir -p "$(dirname "$out_file")"

  local en_content
  en_content=$(cat "$en_file")

  # Build prompt
  local prompt="You are a professional translator for technical documentation.

Translate the following English Markdown document into **${TARGET_LANG_DESC}**.

## RULES:
1. Output ONLY the translated Markdown. No explanations, no code fences wrapping the output.
2. Preserve ALL Markdown formatting, frontmatter (YAML between ---), code blocks, links, and HTML/JSX tags exactly.
3. Do NOT translate: brand names (OpenClaw, Pi, Tailscale, etc.), code/commands, URLs, file paths, JSON keys, JSX component names.
4. Keep the tone clear, concise, and developer-friendly."

  if [[ -n "$GLOSSARY_TEXT" ]]; then
    prompt="$prompt

## GLOSSARY (use these preferred translations):
$GLOSSARY_TEXT"
  fi

  prompt="$prompt

## ENGLISH SOURCE:
$en_content"

  # Add reference translation if available
  if [[ -n "$REF_ROOT" ]]; then
    local ref_file="$REF_ROOT/$rel_path"
    if [[ -f "$ref_file" ]]; then
      local ref_content
      ref_content=$(cat "$ref_file")
      prompt="$prompt

## REFERENCE TRANSLATION (${REF_LANG}, adapt to ${LANG_CODE} conventions):
$ref_content"
    fi
  fi

  echo "TRANSLATING: $rel_path"
  if gemini --model "$MODEL" "$prompt" > "$out_file" 2>/dev/null; then
    # Clean up gemini CLI noise if present
    sed -i '' '/^Loaded cached credentials\.$/d' "$out_file" 2>/dev/null || true
    sed -i '' '/^Hook registry initialized with/d' "$out_file" 2>/dev/null || true
    # Remove ```markdown wrapper if gemini added one
    if head -1 "$out_file" | grep -q '^```markdown$'; then
      sed -i '' '1d' "$out_file" 2>/dev/null || sed -i '1d' "$out_file"
      if tail -1 "$out_file" | grep -q '^```$'; then
        sed -i '' '$ d' "$out_file" 2>/dev/null || sed -i '$ d' "$out_file"
      fi
    fi
    echo "DONE: $rel_path"
  else
    echo "FAIL: $rel_path"
    rm -f "$out_file"
  fi
}

export -f translate_file lang_display
export EN_ROOT OUT_ROOT GLOSSARY_TEXT REF_ROOT REF_LANG LANG_CODE
export TARGET_LANG_DESC MODEL FORCE SUBDIR

# Collect files
search_dir="$EN_ROOT"
[[ -n "$SUBDIR" ]] && search_dir="$EN_ROOT/$SUBDIR"

files=()
while IFS= read -r f; do
  rel="${f#$EN_ROOT/}"
  files+=("$rel")
done < <(find "$search_dir" -name "*.md" -type f | sort)

echo "═══════════════════════════════════════════"
echo "  OpenClaw docs i18n → $LANG_CODE"
echo "  Model: $MODEL | Parallel: $MAX_PARALLEL"
echo "  Files: ${#files[@]} | Subdir: ${SUBDIR:-all}"
[[ -n "$REF_LANG" ]] && echo "  Reference: $REF_LANG"
echo "═══════════════════════════════════════════"

printf '%s\n' "${files[@]}" | xargs -P "$MAX_PARALLEL" -I {} bash -c 'translate_file "$@"' _ {}

echo "═══════════════════════════════════════════"
echo "  Done! Output: $OUT_ROOT"
echo "═══════════════════════════════════════════"
