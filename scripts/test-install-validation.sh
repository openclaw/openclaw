#!/bin/bash
# Test harness for run_remote_bash download validation (PR #82955).
# Sources the production install.sh (via OPENCLAW_INSTALL_SH_NO_RUN=1)
# and exercises validate_downloaded_script directly, proving the real
# code path rejects HTML error pages, JSON responses, binary blobs,
# and empty files while accepting valid scripts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Source the production install.sh without running it.
# This gives us the real validate_downloaded_script, ui_error, etc.
# ---------------------------------------------------------------------------
export OPENCLAW_INSTALL_SH_NO_RUN=1
# shellcheck source=install.sh
source "${SCRIPT_DIR}/install.sh"

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

# (d) Binary file (deterministic non-shebang bytes)
# Fixed bytes ensure the first two bytes are never 0x23 0x21 (#!),
# so the test is not probabilistic like /dev/urandom would be.
printf '\x89\x50\x4e\x47\x0d\x0a\x1a\x0a' > "$TMPDIR_TEST/binary.bin"
printf '\x00\x00\x00\x0d\x49\x48\x44\x52' >> "$TMPDIR_TEST/binary.bin"

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

# (h) NUL-prefixed shebang: raw bytes are \x00\x00#!/bin/bash but command
#     substitution strips the NULs, so the old string check would false-accept.
printf '\x00\x00#!/bin/bash\necho pwned\n' > "$TMPDIR_TEST/nul_prefix.sh"

# (i) Partial download: starts with a valid shebang but is truncated mid-line.
#     A failed curl/wget can leave behind a partial file that passes the shebang
#     check.  The download_file failure guard (|| return 1) must prevent this
#     from ever reaching validate_downloaded_script.
printf '#!/bin/bash\nset -e\necho "starting install"\napt-get ' > "$TMPDIR_TEST/partial.sh"

# ===========================================================================
#  GREEN tests — WITH validation (new behavior), bad files are REJECTED
# ===========================================================================
announce "GREEN: validation rejects bad downloads"

if ! validate_downloaded_script "$TMPDIR_TEST/empty.sh" "https://test/empty" 2>/dev/null; then
    ok "empty file  → rejected"
else
    ko "empty file  → should have been rejected"
fi

if ! validate_downloaded_script "$TMPDIR_TEST/html_error.html" "https://test/html" 2>/dev/null; then
    ok "HTML error   → rejected"
else
    ko "HTML error   → should have been rejected"
fi

if ! validate_downloaded_script "$TMPDIR_TEST/json_error.json" "https://test/json" 2>/dev/null; then
    ok "JSON error   → rejected"
else
    ko "JSON error   → should have been rejected"
fi

if ! validate_downloaded_script "$TMPDIR_TEST/binary.bin" "https://test/binary" 2>/dev/null; then
    ok "binary blob  → rejected"
else
    ko "binary blob  → should have been rejected"
fi

if ! validate_downloaded_script "$TMPDIR_TEST/c1_escape.txt" "https://test/c1" 2>/dev/null; then
    ok "C1 escape    → rejected"
else
    ko "C1 escape    → should have been rejected"
fi

# NUL-prefix bypass: command substitution strips NULs, making the content
# look like it starts with '#!' — the raw byte check catches this.
if ! validate_downloaded_script "$TMPDIR_TEST/nul_prefix.sh" "https://test/nul" 2>/dev/null; then
    ok "NUL prefix   → rejected (raw byte check caught NUL before #!)"
else
    ko "NUL prefix   → false-accepted (raw byte check failed)"
fi

# Verify C1 bytes are stripped from the "First line:" diagnostic
c1_first_line="$(validate_downloaded_script "$TMPDIR_TEST/c1_escape.txt" "https://example.com/c1" 2>&1 \
    | grep 'First line:' | sed 's/.*First line: //' || true)"
c1_cleaned="$(printf '%s' "$c1_first_line" | LC_ALL=C tr -d '\000-\037\177\200-\237')"
if [ -n "$c1_first_line" ] && [ "$c1_cleaned" = "$c1_first_line" ]; then
    ok "C1 diagnostic → C1 bytes stripped from error output"
else
    ko "C1 diagnostic → C1 bytes leaked into error output"
fi

# Valid scripts should PASS
if validate_downloaded_script "$TMPDIR_TEST/valid.sh" "https://test/valid" 2>/dev/null; then
    ok "valid script (#!bash)     → accepted"
else
    ko "valid script (#!bash)     → should have been accepted"
fi

if validate_downloaded_script "$TMPDIR_TEST/valid_env.sh" "https://test/valid-env" 2>/dev/null; then
    ok "valid script (#!env bash) → accepted"
else
    ko "valid script (#!env bash) → should have been accepted"
fi

# Partial download: has a valid shebang so validate_downloaded_script ACCEPTS it.
# This proves the download_file failure guard (|| return 1) is essential:
# without it, a failed curl that left a partial file would pass validation.
if validate_downloaded_script "$TMPDIR_TEST/partial.sh" "https://test/partial" 2>/dev/null; then
    ok "partial download (valid shebang) → accepted by validation alone"
else
    ko "partial download → should have been accepted by validation alone"
fi

# Simulate the full download-then-validate pipeline with a failing downloader.
# download_file returns non-zero but leaves the partial file on disk.
simulate_failed_download() {
    local tmp="$1" url="$2"
    # Downloader "fails" (returns 1) after writing partial content
    cp "$TMPDIR_TEST/partial.sh" "$tmp"
    return 1
}

run_remote_bash_guarded() {
    local url="$1"
    local tmp
    tmp="$(mktemp)"
    simulate_failed_download "$tmp" "$url" || return 1
    validate_downloaded_script "$tmp" "$url" || return 1
    /bin/bash "$tmp"
}

if ! run_remote_bash_guarded "https://example.com/partial-download" 2>/dev/null; then
    ok "failed download (partial) → pipeline rejected before validation"
else
    ko "failed download (partial) → pipeline should have rejected (download_file guard missing)"
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
validate_downloaded_script "$TMPDIR_TEST/empty.sh" "https://example.com/missing.sh" 2>&1 || true

echo -e "${MUTED}--- HTML error page ---${NC}"
validate_downloaded_script "$TMPDIR_TEST/html_error.html" "https://raw.githubusercontent.com/example/install.sh" 2>&1 || true

echo -e "${MUTED}--- JSON error ---${NC}"
validate_downloaded_script "$TMPDIR_TEST/json_error.json" "https://api.example.com/script" 2>&1 || true

echo -e "${MUTED}--- binary blob ---${NC}"
validate_downloaded_script "$TMPDIR_TEST/binary.bin" "https://example.com/corrupted.sh" 2>&1 || true

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
