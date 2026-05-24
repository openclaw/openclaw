#!/bin/bash
# Test harness for run_remote_bash download validation (PR #82955).
# Demonstrates that the shebang + non-empty checks reject HTML error pages,
# JSON responses, binary blobs, and empty files while accepting valid scripts.

set -euo pipefail

BOLD='\033[1m'
NC='\033[0m'
GREEN='\033[38;2;0;229;204m'
RED='\033[38;2;230;57;70m'
MUTED='\033[38;2;90;100;128m'

pass=0
fail=0

announce() { echo -e "\n${BOLD}── $1 ──${NC}"; }
ok()       { pass=$((pass+1)); echo -e "  ${GREEN}✓ PASS${NC}  $1"; }
ko()       { fail=$((fail+1)); echo -e "  ${RED}✗ FAIL${NC}  $1"; }

# ---------------------------------------------------------------------------
# Minimal stubs so the real install.sh functions work in isolation
# ---------------------------------------------------------------------------
GUM=""
ERROR='\033[38;2;230;57;70m'
NC_REAL='\033[0m'
ui_error() { echo -e "${ERROR}✗${NC_REAL} $*" >&2; }

# ---------------------------------------------------------------------------
# Extract the validation logic exactly as it appears in install.sh.
# We wrap it in validate_script() so we can call it with a local file path.
# ---------------------------------------------------------------------------
validate_script() {
    local tmp="$1"
    local url="${2:-<test-input>}"

    if [[ ! -s "$tmp" ]]; then
        ui_error "Downloaded script is empty: ${url}"
        return 1
    fi
    local first_line
    first_line="$(head -c 256 "$tmp" | head -1)"
    if [[ "$first_line" != "#!"* ]]; then
        local safe_line
        safe_line="$(printf '%s' "${first_line:0:80}" | LC_ALL=C tr -d '\000-\037\177\200-\237')"
        safe_line="${safe_line//\\/\\\\}"
        ui_error "Downloaded file does not look like a shell script (no shebang): ${url}"
        ui_error "First line: ${safe_line}"
        return 1
    fi
    return 0
}

# The OLD behavior: no validation at all (always succeeds)
no_validate() {
    return 0
}

# ---------------------------------------------------------------------------
# Build test fixtures
# ---------------------------------------------------------------------------
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# (a) Empty file
touch "$TMPDIR_TEST/empty.sh"

# (b) HTML error page
cat > "$TMPDIR_TEST/html_error.html" << 'HTML'
<html>
<head><title>404 Not Found</title></head>
<body>
<h1>Not Found</h1>
<p>The requested URL was not found on this server.</p>
</body>
</html>
HTML

# (c) JSON error response
cat > "$TMPDIR_TEST/json_error.json" << 'JSON'
{"error":"not_found","message":"The requested resource does not exist","status":404}
JSON

# (d) Binary file (64 random bytes)
head -c 64 /dev/urandom > "$TMPDIR_TEST/binary.bin"

# (e) Valid shell script
cat > "$TMPDIR_TEST/valid.sh" << 'VALID'
#!/bin/bash
echo "Hello from a valid script"
VALID

# (f) Valid env-style shebang
cat > "$TMPDIR_TEST/valid_env.sh" << 'ENVSH'
#!/usr/bin/env bash
echo "Hello from env-bash script"
ENVSH

# (g) File with C1 control bytes (0x9B = CSI, could inject terminal escapes)
printf '\x9b\x33\x31\x6dPWNED\x9b\x30\x6d rest of line\n' > "$TMPDIR_TEST/c1_escape.txt"

# ===========================================================================
#  GREEN tests — WITH validation (new behavior), bad files are REJECTED
# ===========================================================================
announce "GREEN: validation rejects bad downloads"

if ! validate_script "$TMPDIR_TEST/empty.sh" 2>/dev/null; then
    ok "empty file  → rejected"
else
    ko "empty file  → should have been rejected"
fi

if ! validate_script "$TMPDIR_TEST/html_error.html" 2>/dev/null; then
    ok "HTML error   → rejected"
else
    ko "HTML error   → should have been rejected"
fi

if ! validate_script "$TMPDIR_TEST/json_error.json" 2>/dev/null; then
    ok "JSON error   → rejected"
else
    ko "JSON error   → should have been rejected"
fi

if ! validate_script "$TMPDIR_TEST/binary.bin" 2>/dev/null; then
    ok "binary blob  → rejected"
else
    ko "binary blob  → should have been rejected"
fi

if ! validate_script "$TMPDIR_TEST/c1_escape.txt" 2>/dev/null; then
    ok "C1 escape    → rejected"
else
    ko "C1 escape    → should have been rejected"
fi

# Verify C1 bytes are stripped from the "First line:" diagnostic
c1_first_line="$(validate_script "$TMPDIR_TEST/c1_escape.txt" "https://example.com/c1" 2>&1 \
    | grep 'First line:' | sed 's/.*First line: //' || true)"
if [ -n "$c1_first_line" ] && ! printf '%s' "$c1_first_line" | LC_ALL=C grep -qP '[\x00-\x1f\x7f\x80-\x9f]'; then
    ok "C1 diagnostic → C1 bytes stripped from error output"
else
    ko "C1 diagnostic → C1 bytes leaked into error output"
fi

# Valid scripts should PASS
if validate_script "$TMPDIR_TEST/valid.sh" 2>/dev/null; then
    ok "valid script (#!bash)     → accepted"
else
    ko "valid script (#!bash)     → should have been accepted"
fi

if validate_script "$TMPDIR_TEST/valid_env.sh" 2>/dev/null; then
    ok "valid script (#!env bash) → accepted"
else
    ko "valid script (#!env bash) → should have been accepted"
fi

# ===========================================================================
#  RED tests — WITHOUT validation (old behavior), everything is "accepted"
# ===========================================================================
announce "RED: no validation lets bad downloads through"

if no_validate "$TMPDIR_TEST/empty.sh"; then
    ok "empty file  → accepted (DANGEROUS without validation)"
else
    ko "empty file  → unexpectedly rejected"
fi

if no_validate "$TMPDIR_TEST/html_error.html"; then
    ok "HTML error   → accepted (DANGEROUS without validation)"
else
    ko "HTML error   → unexpectedly rejected"
fi

if no_validate "$TMPDIR_TEST/json_error.json"; then
    ok "JSON error   → accepted (DANGEROUS without validation)"
else
    ko "JSON error   → unexpectedly rejected"
fi

if no_validate "$TMPDIR_TEST/binary.bin"; then
    ok "binary blob  → accepted (DANGEROUS without validation)"
else
    ko "binary blob  → unexpectedly rejected"
fi

# ===========================================================================
#  Error message demo — show what the user sees when validation fires
# ===========================================================================
announce "Error messages shown to the user"

echo -e "${MUTED}--- empty file ---${NC}"
validate_script "$TMPDIR_TEST/empty.sh" "https://example.com/missing.sh" 2>&1 || true

echo -e "${MUTED}--- HTML error page ---${NC}"
validate_script "$TMPDIR_TEST/html_error.html" "https://raw.githubusercontent.com/example/install.sh" 2>&1 || true

echo -e "${MUTED}--- JSON error ---${NC}"
validate_script "$TMPDIR_TEST/json_error.json" "https://api.example.com/script" 2>&1 || true

echo -e "${MUTED}--- binary blob ---${NC}"
validate_script "$TMPDIR_TEST/binary.bin" "https://example.com/corrupted.sh" 2>&1 || true

# ===========================================================================
#  Summary
# ===========================================================================
echo ""
echo -e "${BOLD}Results: ${GREEN}${pass} passed${NC}, ${RED}${fail} failed${NC}"
if [[ $fail -eq 0 ]]; then
    echo -e "${GREEN}All checks passed — validation works as intended.${NC}"
else
    echo -e "${RED}Some checks failed!${NC}"
    exit 1
fi
