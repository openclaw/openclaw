#!/usr/bin/env bash
# scan-hidden-bugs.sh — Scan for common hidden bug patterns in the OpenClaw codebase.
#
# Usage:
# ./scripts/scan-hidden-bugs.sh # scan src/ only
# ./scripts/scan-hidden-bugs.sh --all # scan src/ + extensions/
# ./scripts/scan-hidden-bugs.sh --pattern jsonify # single pattern
# ./scripts/scan-hidden-bugs.sh --list # list available patterns
#
# Patterns cover:
# 1. JSON.stringify without undefined guard (silent "undefined" string)
# 2. Empty catch blocks (silent error swallowing)
# 3. typeof x === "object" without null guard
# 4. JSON.parse on external data without try-catch
# 5. parseInt without radix parameter
# 6. Unbounded response reads (.json() / .text() without limit)
# 7. Missing await on async calls
# 8. process.exit() in library code

set -euo pipefail

# --- config ---
SRC_DIR="src"
INCLUDE_EXTENSIONS=false
SINGLE_PATTERN=""
LIST_PATTERNS=false
EXCLUDE_TESTS="--glob '!*test-helpers*'"

# --- color ---
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# --- parse args ---
for arg in "$@"; do
 case "$arg" in
 --all) INCLUDE_EXTENSIONS=true ;;
 --pattern) SINGLE_PATTERN="$2"; shift ;;
 --list) LIST_PATTERNS=true ;;
 esac
done

if $LIST_PATTERNS; then
 echo "Available patterns:"
 echo " jsonify — JSON.stringify without undefined guard"
 echo " emptycatch — Empty catch blocks"
 echo " typeofobj — typeof x === 'object' without null guard"
 echo " jsonparse — JSON.parse on external data without try-catch"
 echo " parseint — parseInt without radix parameter"
 echo " unbounded — Unbounded response reads"
 echo " exitlib — process.exit() in library code"
 exit 0
fi

SCOPE="$SRC_DIR"
$INCLUDE_EXTENSIONS && SCOPE="$SRC_DIR extensions"

# --- helpers ---
# grep_ts: grep TypeScript/TSX files, excluding tests
# Usage: grep_ts -n "pattern" dir1 dir2 ...
# Uses plain grep so the script works in child bash processes.

header() {
 echo -e "\n${BOLD}${CYAN}═══ $1 ═══${NC}\n"
}

match() {
 local desc="$1" pattern="$2"
 header "$desc"
 grep -Ern "$pattern" $SCOPE 2>/dev/null || echo -e " ${GREEN}(none found)${NC}"
}

count() {
 grep -Ern "$1" $SCOPE 2>/dev/null | wc -l
}

# ===================================================================
# Pattern 1: JSON.stringify without undefined guard
# ===================================================================
scan_jsonify() {
 header "1. JSON.stringify in template literals without undefined guard"
 echo -e " ${YELLOW}Risk:${NC} JSON.stringify returns undefined for non-serializable roots"
 echo -e " ${YELLOW}Fix:${NC} check if (serialized === undefined) before using\n"

 local hits=0
 while IFS= read -r line; do
 local file=$(echo "$line" | cut -d: -f1)
 local lnum=$(echo "$line" | cut -d: -f2)
 # Per-LINE: check if this line's immediate context already has a guard
 local start=$((lnum > 2 ? lnum - 2 : 1))
 local end=$((lnum + 5))
 local ctx=$(sed -n "${start},${end}p" "$file" 2>/dev/null || true)
 if echo "$ctx" | grep -Eq "serialized === undefined\|=== undefined.*throw\|if.*===.*undefined"; then
 continue
 fi
 # Also skip if it uses null,2 formatting (always produces string for objects)
 if echo "$line" | grep -Eq 'null,\s*2'; then
 continue
 fi
 echo -e " ${RED}$file:$lnum${NC}"
 hits=$((hits + 1))
 done < <(grep -Ern '`\$\{JSON[.]stringify\(' $SCOPE 2>/dev/null || true)

 if [ "$hits" -eq 0 ]; then
 echo -e " ${GREEN}(none found — all guarded or using null,2)${NC}"
 else
 echo -e "\n ${BOLD}Total: $hits unguarded${NC}"
 fi
}

# ===================================================================
# Pattern 2: Empty catch blocks
# ===================================================================
scan_emptycatch() {
 header "2. Empty catch blocks (silent error swallowing)"
 echo -e " ${YELLOW}Risk:${NC} Errors silently dropped with no diagnostic"
 echo -e " ${YELLOW}Fix:${NC} add logWarn/logError or propagate\n"

 local hits=0
 while IFS= read -r file; do
 # Show the catch context from the file
 local matches=$(grep -Ern 'catch\s*\{' "$file" -A2 2>/dev/null | grep -v '\.test\.ts' || true)
 if echo "$matches" | grep -Eq 'catch\s*{\s*$' && ! echo "$matches" | grep -Eq 'throw\|error\|err\|log\|warn\|reject\|return\|//\|/\*'; then
 echo -e " ${RED}$file${NC}"
 echo "$matches" | grep 'catch' | while read -r cline; do
 echo -e " ${YELLOW}$cline${NC}"
 done
 hits=$((hits + 1))
 fi
 done < <(grep -Erl 'catch\s*\{' $SCOPE 2>/dev/null || true)

 if [ "$hits" -eq 0 ]; then
 echo -e " ${GREEN}(none found)${NC}"
 else
 echo -e "\n ${BOLD}Total: $hits files with empty catch blocks${NC}"
 fi
}

# ===================================================================
# Pattern 3: typeof x === "object" without null guard
# ===================================================================
scan_typeofobj() {
 header "3. typeof x === 'object' without null guard"
 echo -e " ${YELLOW}Risk:${NC} null passes typeof === 'object', causes TypeError downstream"
 echo -e " ${YELLOW}Fix:${NC} add x !== null && or use isRecord() helper\n"

 local hits=0
 while IFS= read -r line; do
 local file=$(echo "$line" | cut -d: -f1)
 local lnum=$(echo "$line" | cut -d: -f2)
 local ctx=$(echo "$line" | cut -d: -f3-)
 # Skip if nearby lines have null check
 local before=$(grep -Ern "!== null\|!= null\|!==null\|!=null\|&&.*null\|null &&\|null !==" "$file" 2>/dev/null || true)
 # Simple: just flag all — human review needed
 echo -e " ${RED}$file:$lnum${NC} ${ctx:0:100}"
 hits=$((hits + 1))
 done < <(grep -Ern "typeof .* === .object" $SCOPE 2>/dev/null || true)

 if [ "$hits" -eq 0 ]; then
 echo -e " ${GREEN}(none found)${NC}"
 else
 echo -e "\n ${BOLD}Total: $hits occurrences — review each for upstream null guard${NC}"
 fi
}

# ===================================================================
# Pattern 4: JSON.parse on external data without try-catch
# ===================================================================
scan_jsonparse() {
 header "4. JSON.parse on file/response data — check for try-catch"
 echo -e " ${YELLOW}Risk:${NC} Malformed JSON from external source crashes process"
 echo -e " ${YELLOW}Fix:${NC} wrap in try-catch or use schema validation\n"

 local hits=0
 while IFS= read -r line; do
 local file=$(echo "$line" | cut -d: -f1)
 local lnum=$(echo "$line" | cut -d: -f2)
 # Check if this line is inside a try block
 local start=$((lnum > 10 ? lnum - 10 : 1))
 local before=$(sed -n "${start},${lnum}p" "$file" 2>/dev/null | grep -Ec "try {" || true)
 if [ "$before" -gt 0 ]; then
 continue
 fi
 echo -e " ${RED}$file:$lnum${NC}"
 hits=$((hits + 1))
 done < <(grep -Ern 'JSON[.]parse\(.*readFile|JSON[.]parse\(.*response|JSON[.]parse\(.*await|JSON[.]parse\(readFile|JSON[.]parse\(await' $SCOPE 2>/dev/null || true)

 if [ "$hits" -eq 0 ]; then
 echo -e " ${GREEN}(all guarded or unreachable)${NC}"
 else
 echo -e "\n ${BOLD}Total: $hits unguarded${NC}"
 fi
}

# ===================================================================
# Pattern 5: parseInt without radix
# ===================================================================
scan_parseint() {
 header "5. parseInt without radix parameter"
 echo -e " ${YELLOW}Risk:${NC} parseInt('08') returns 0 in older engines; ambiguous octal/hex"
 echo -e " ${YELLOW}Fix:${NC} parseInt(x, 10) or Number(x)\n"

 match "parseInt calls missing radix:" 'parseInt\([^,)]+\)'
}

# ===================================================================
# Pattern 6: Unbounded response reads
# ===================================================================
scan_unbounded() {
 header "6. Unbounded response reads (potential OOM)"
 echo -e " ${YELLOW}Risk:${NC} Large response bodies exhaust memory"
 echo -e " ${YELLOW}Fix:${NC} use readResponseWithLimit() or readProviderJsonResponse()\n"

 # Collect all matches, then filter per-line
 local tmpfile=$(mktemp)
 for dir in $SCOPE; do
 for pattern in 'await .*\.json\(' 'await .*[.]text[(][)](' 'response\.json\('; do
 grep -Ern "$pattern" "$dir" --include='*.ts' --include='*.tsx' \
 2>/dev/null | grep -v '\.test\.ts\|\.test-helpers\|test-support\|test-utils' || true
 done
 done | sort -u > "$tmpfile"

 local hits=0
 while IFS= read -r line; do
 [ -z "$line" ] && continue
 local file=$(echo "$line" | cut -d: -f1)
 local lnum=$(echo "$line" | cut -d: -f2)
 local start=$((lnum > 3 ? lnum - 3 : 1))
 local end=$((lnum + 3))
 local ctx=$(sed -n "${start},${end}p" "$file" 2>/dev/null || true)
 if echo "$ctx" | grep -Eq "readResponseWithLimit\|readProviderJsonResponse\|readResponseTextWithLimit"; then
 continue
 fi
 if echo "$ctx" | grep -Eq "readGoogleApiErrorDetail\|createMSTeamsHttpError"; then
 continue
 fi
 echo -e " ${RED}$file:$lnum${NC}"
 hits=$((hits + 1))
 done < "$tmpfile"

 rm -f "$tmpfile"

 if [ "$hits" -eq 0 ]; then
 echo -e " ${GREEN}(all bounded)${NC}"
 else
 echo -e "\n ${BOLD}Total: $hits unbounded reads${NC}"
 fi
}

# ===================================================================
# Pattern 7: process.exit() in library code
# ===================================================================
scan_exitlib() {
 header "7. process.exit() in non-CLI source code"
 echo -e " ${YELLOW}Risk:${NC} Kills process from library code — no cleanup, no error handling"
 echo -e " ${YELLOW}Fix:${NC} throw an error instead, let the CLI entry point handle exit\n"

 local hits=0
 while IFS= read -r line; do
 local file=$(echo "$line" | cut -d: -f1)
 # Exclude CLI entry points
 case "$file" in
 src/cli/*|src/commands/*|src/entry.*) continue ;;
 esac
 echo -e " ${RED}$line${NC}"
 hits=$((hits + 1))
 done < <(grep -Ern 'process[.]exit\(' $SCOPE 2>/dev/null || true)

 if [ "$hits" -eq 0 ]; then
 echo -e " ${GREEN}(none found in library code)${NC}"
 else
 echo -e "\n ${BOLD}Total: $hits in library code${NC}"
 fi
}

# ===================================================================
# Pattern 8: throw new Error("exit ...") anti-pattern
# ===================================================================
scan_exiterror() {
 header "8. throw new Error('exit ...') — control flow via generic Error"
 echo -e " ${YELLOW}Risk:${NC} Upstream catch blocks mistake exit signal for real crash"
 echo -e " ${YELLOW}Fix:${NC} use a typed ExitError class (see issue #97796)\n"

 match "throw new Error.*exit" 'throw new Error\(.*exit'
}

# ===================================================================
# Main
# ===================================================================
echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║ OpenClaw Hidden Bug Scanner ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo "Scope: $SCOPE"
echo "Date: $(date -Iseconds)"

case "$SINGLE_PATTERN" in
 jsonify) scan_jsonify ;;
 emptycatch) scan_emptycatch ;;
 typeofobj) scan_typeofobj ;;
 jsonparse) scan_jsonparse ;;
 parseint) scan_parseint ;;
 unbounded) scan_unbounded ;;
 exitlib) scan_exitlib ;;
 exiterror) scan_exiterror ;;
 "")
 scan_jsonify
 scan_emptycatch
 scan_typeofobj
 scan_jsonparse
 scan_parseint
 scan_unbounded
 scan_exitlib
 scan_exiterror
 ;;
 *)
 echo "Unknown pattern: $SINGLE_PATTERN"
 echo "Use --list to see available patterns"
 exit 1
 ;;
esac

echo -e "\n${GREEN}${BOLD}═══ Scan complete ═══${NC}\n"
