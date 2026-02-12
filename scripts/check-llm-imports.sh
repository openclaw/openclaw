#!/usr/bin/env bash
#
# LLM Import Enforcement Gates (A, B, C)
# Prevents bypass paths for model tiering router.
#
# Gate A: Provider SDK imports (openai, @anthropic-ai/*) - router-only
# Gate B: Embedded runner module imports - router-only  
# Gate C: Raw HTTP provider endpoint calls - router-only
#
# Usage:
#   ./scripts/check-llm-imports.sh          # Check entire src/ directory
#   ./scripts/check-llm-imports.sh <file>   # Check single file (for fixture testing)
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# --- Configuration ---

# Router allowlist: files that MAY import provider SDKs/transports
# Note: pi-embedded-runner module CAN re-export itself (src/agents/pi-embedded-runner.ts)
ROUTER_ALLOWLIST_RE='^src/agents/router/|^src/agents/model-fallback\.ts$|^src/agents/tools/image-tool\.ts$|^src/agents/pi-embedded-runner/|^src/agents/pi-embedded-runner\.ts$|^src/memory/embeddings-|^src/memory/batch-|^src/memory/openai-batch\.ts$|^src/gateway/openai-http\.ts$|^src/infra/provider-usage\.fetch\.'

# Additional allowlist for type-only imports (Gate B) - importing types is safe
TYPE_IMPORT_ALLOWLIST_RE='^src/gateway/openresponses-http\.ts$|^src/agents/pi-tool-definition-adapter\.ts$|^src/commands/agent/types\.ts$'

# Allowlist for base URL constants (Gate C) - defining constants is not a bypass
BASE_URL_CONSTANT_ALLOWLIST_RE='^src/tts/tts\.ts$|^src/media-understanding/providers/|^src/gateway/test-helpers\.'

# Exceptions manifest
EXCEPTIONS_FILE="docs/router-llm-import-exceptions.json"

# Fixture directory (excluded from main scan)
FIXTURE_DIR="test/ci-gates/import-detection-fixtures"

ERRORS=0

# --- Helper functions ---

log_error() {
  echo "ERROR: $*" >&2
  ERRORS=$((ERRORS + 1))
}

log_info() {
  echo "INFO: $*"
}

# Check if file is in exceptions manifest
is_excepted() {
  local file="$1"
  local gate="$2"
  
  if [[ ! -f "$EXCEPTIONS_FILE" ]]; then
    return 1
  fi
  
  # Check if file path exists in exceptions and gate matches
  local match
  match=$(jq -r --arg path "$file" --arg gate "$gate" '
    .exceptions[] | 
    select(.path == $path) | 
    select(.gates == null or (.gates | index($gate)))
  ' "$EXCEPTIONS_FILE" 2>/dev/null || echo "")
  
  if [[ -n "$match" ]]; then
    # Check expiry
    local expires_at
    expires_at=$(echo "$match" | jq -r '.expiresAt' 2>/dev/null || echo "")
    if [[ -n "$expires_at" ]]; then
      local now_epoch expires_epoch
      now_epoch=$(date -u +%s)
      expires_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$expires_at" +%s 2>/dev/null || date -d "$expires_at" +%s 2>/dev/null || echo "0")
      if [[ "$now_epoch" -gt "$expires_epoch" ]]; then
        log_error "EXPIRED EXCEPTION for $file (expired: $expires_at)"
        return 1
      fi
    fi
    return 0
  fi
  return 1
}

# Check if file is in router allowlist
is_router_allowed() {
  local file="$1"
  local rel="${file#./}"
  [[ "$rel" =~ $ROUTER_ALLOWLIST_RE ]]
}

# Check if file is in type import allowlist (Gate B only)
is_type_import_allowed() {
  local file="$1"
  local rel="${file#./}"
  [[ "$rel" =~ $TYPE_IMPORT_ALLOWLIST_RE ]]
}

# Check if file is in base URL constant allowlist (Gate C only)
is_base_url_constant_allowed() {
  local file="$1"
  local rel="${file#./}"
  [[ "$rel" =~ $BASE_URL_CONSTANT_ALLOWLIST_RE ]]
}

# Check if this is a fixture (should be caught, not exempted)
is_fixture() {
  local file="$1"
  [[ "$file" == *"ci-gates/import-detection-fixtures"* ]]
}

# Check if line is a comment
is_comment_line() {
  local line_content="$1"
  # Match lines that are primarily comments
  [[ "$line_content" =~ ^[[:space:]]*(//|\*|/\*) ]]
}

# --- Gate A: Provider SDK Imports ---

check_gate_a() {
  local target="${1:-src}"
  
  # Pattern matches: from "openai", from '@anthropic-ai/...', require("openai"), etc.
  # Must be an actual import statement, not a comment
  local pattern='(from\s+["\x27]openai["\x27]|from\s+["\x27]openai/|from\s+["\x27]@anthropic-ai/|require\s*\(\s*["\x27]openai["\x27]\s*\)|require\s*\(\s*["\x27]@anthropic-ai/|import\s*\(\s*["\x27]openai["\x27]\s*\)|import\s*\(\s*["\x27]@anthropic-ai/)'
  
  local hits
  # -H ensures filename is always shown (even for single file)
  hits=$(rg -Hn "$pattern" "$target" 2>/dev/null || true)
  
  if [[ -z "$hits" ]]; then
    return 0
  fi
  
  while IFS= read -r line; do
    local file line_num line_content
    file=$(echo "$line" | cut -d: -f1)
    line_num=$(echo "$line" | cut -d: -f2)
    line_content="${line#*:*:}"
    local rel="${file#./}"
    
    # Skip comments
    if is_comment_line "$line_content"; then
      continue
    fi
    
    # Skip test files (not fixtures)
    if [[ "$rel" == *.test.ts ]] && ! is_fixture "$rel"; then
      continue
    fi
    
    # Check allowlist
    if is_router_allowed "$rel"; then
      continue
    fi
    
    # Check exceptions (unless fixture)
    if ! is_fixture "$rel" && is_excepted "$rel" "A"; then
      log_info "Exception applied for Gate A: $rel"
      continue
    fi
    
    log_error "Gate A violation - Provider SDK import outside router: $line"
  done <<< "$hits"
}

# --- Gate B: Embedded Runner Module Imports ---

check_gate_b() {
  local target="${1:-src}"
  
  # Pattern matches imports from pi-embedded-runner/run modules
  local pattern='(from\s+["\x27][^"\x27]*pi-embedded-runner/run[^"\x27]*["\x27]|require\s*\(\s*["\x27][^"\x27]*pi-embedded-runner/run[^"\x27]*["\x27]\s*\)|import\s*\(\s*["\x27][^"\x27]*pi-embedded-runner/run[^"\x27]*["\x27]\s*\))'
  
  local hits
  hits=$(rg -Hn "$pattern" "$target" 2>/dev/null || true)
  
  if [[ -z "$hits" ]]; then
    return 0
  fi
  
  while IFS= read -r line; do
    local file line_num line_content
    file=$(echo "$line" | cut -d: -f1)
    line_num=$(echo "$line" | cut -d: -f2)
    line_content="${line#*:*:}"
    local rel="${file#./}"
    
    # Skip test files (not fixtures)
    if [[ "$rel" == *.test.ts ]] && ! is_fixture "$rel"; then
      continue
    fi
    
    # Check allowlist (pi-embedded-runner itself is allowed)
    if is_router_allowed "$rel"; then
      continue
    fi
    
    # Allow type-only imports (import type { ... } from ...)
    if [[ "$line_content" =~ import[[:space:]]+type ]]; then
      continue
    fi
    
    # Check type import allowlist for files that only import types
    if is_type_import_allowed "$rel"; then
      continue
    fi
    
    # Check exceptions (unless fixture)
    if ! is_fixture "$rel" && is_excepted "$rel" "B"; then
      log_info "Exception applied for Gate B: $rel"
      continue
    fi
    
    log_error "Gate B violation - Embedded runner import outside router: $line"
  done <<< "$hits"
}

# --- Gate C: Raw HTTP Provider Endpoints ---

check_gate_c() {
  local target="${1:-src}"
  
  # Known provider API domains
  local domains='api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.gemini\.google\.com'
  
  # Pattern matches string literals containing provider domains
  local pattern="[\"'\`][^\"'\`]*(${domains})[^\"'\`]*[\"'\`]"
  
  local hits
  hits=$(rg -Hn "$pattern" "$target" 2>/dev/null || true)
  
  if [[ -z "$hits" ]]; then
    return 0
  fi
  
  while IFS= read -r line; do
    local file line_num line_content
    file=$(echo "$line" | cut -d: -f1)
    line_num=$(echo "$line" | cut -d: -f2)
    line_content="${line#*:*:}"
    local rel="${file#./}"
    
    # Skip test files (not fixtures), config files, docs
    if [[ "$rel" == *.test.ts ]] && ! is_fixture "$rel"; then
      continue
    fi
    if [[ "$rel" == *.md || "$rel" == *.json || "$rel" == *.yaml || "$rel" == *.yml ]]; then
      continue
    fi
    
    # Skip comments
    if is_comment_line "$line_content"; then
      continue
    fi
    
    # Check allowlist
    if is_router_allowed "$rel"; then
      continue
    fi
    
    # Check base URL constant allowlist (not actual bypass - just defining constants)
    if is_base_url_constant_allowed "$rel"; then
      continue
    fi
    
    # Check exceptions (unless fixture)  
    if ! is_fixture "$rel" && is_excepted "$rel" "C"; then
      log_info "Exception applied for Gate C: $rel"
      continue
    fi
    
    log_error "Gate C violation - Raw HTTP provider endpoint outside router: $line"
  done <<< "$hits"
}

# --- Exceptions manifest validation ---

validate_exceptions_manifest() {
  if [[ ! -f "$EXCEPTIONS_FILE" ]]; then
    log_info "No exceptions manifest found at $EXCEPTIONS_FILE (this is OK if no exceptions needed)"
    return 0
  fi
  
  # Check JSON validity
  if ! jq empty "$EXCEPTIONS_FILE" 2>/dev/null; then
    log_error "Invalid JSON in exceptions manifest: $EXCEPTIONS_FILE"
    return 1
  fi
  
  # Check for expired exceptions
  local now_epoch
  now_epoch=$(date -u +%s)
  
  local expired
  expired=$(jq -r --argjson now "$now_epoch" '
    .exceptions[] | 
    select(.expiresAt != null) |
    select((.expiresAt | fromdateiso8601) < $now) |
    "\(.path) expired at \(.expiresAt)"
  ' "$EXCEPTIONS_FILE" 2>/dev/null || echo "")
  
  if [[ -n "$expired" ]]; then
    while IFS= read -r exp; do
      log_error "EXPIRED EXCEPTION: $exp"
    done <<< "$expired"
  fi
  
  # Check for glob patterns in paths (forbidden)
  local globs
  globs=$(jq -r '.exceptions[] | select(.path | test("[*?\\[\\]]")) | .path' "$EXCEPTIONS_FILE" 2>/dev/null || echo "")
  
  if [[ -n "$globs" ]]; then
    while IFS= read -r glob_path; do
      log_error "NO GLOBS ALLOWED in exception path: $glob_path"
    done <<< "$globs"
  fi
}

# --- Main ---

main() {
  local target="${1:-}"
  
  log_info "Running LLM Import Enforcement Gates..."
  
  # Validate exceptions manifest first
  validate_exceptions_manifest
  
  if [[ -n "$target" ]]; then
    # Single file mode (for fixture testing)
    log_info "Checking single file: $target"
    check_gate_a "$target"
    check_gate_b "$target"
    check_gate_c "$target"
  else
    # Full scan mode
    log_info "Scanning src/ directory..."
    check_gate_a "src"
    check_gate_b "src"
    check_gate_c "src"
  fi
  
  if [[ "$ERRORS" -gt 0 ]]; then
    echo
    echo "FAILED: $ERRORS LLM import violation(s) found."
    echo "See docs/router-llm-import-exceptions.json for exception process."
    exit 1
  fi
  
  echo "OK: All LLM import gates passed."
}

main "$@"
