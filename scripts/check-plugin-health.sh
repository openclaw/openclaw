#!/usr/bin/env bash
# check-plugin-health.sh — OpenClaw plugin health checker
#
# Verifies that every installed extension's bundled `openclaw` peer
# matches the running gateway version, checks LCM database health
# (when the LCM plugin is installed), and reports plugin load status.
#
# Run after `openclaw update` or anytime you suspect a plugin issue.
#
# Background
# ----------
# npm-sourced plugins bundle their own copy of `openclaw` as a peer
# dependency.  When the gateway updates but the plugin's peer stays
# at the old version, the plugin may *load without error* yet
# silently malfunction — queries return empty, hooks don't fire, etc.
# This script catches that mismatch before it bites you.
#
# Exit codes:
#   0  All checks passed
#   1  One or more issues found (details printed)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
EXTENSIONS_DIR="${OPENCLAW_STATE_DIR}/extensions"
LCM_DB="${OPENCLAW_STATE_DIR}/lcm.db"

ISSUES=0

echo "=== OpenClaw Plugin Health Check ==="
echo ""

# ── Helper: read a key from a JSON file (portable, no grep -P) ──────

json_value() {
    local file="$1" key="$2"
    python3 -c "import json; print(json.load(open('$file')).get('$key','unknown'))" 2>/dev/null || echo "unknown"
}

# ── 1. Gateway version ──────────────────────────────────────────────

GATEWAY_VERSION=$(openclaw --version 2>/dev/null \
  | sed -nE 's/.*([0-9]{4}\.[0-9]+\.[0-9]+).*/\1/p' || echo "")

if [[ -z "${GATEWAY_VERSION}" ]]; then
    echo "✗ Could not determine gateway version — is openclaw in PATH?"
    exit 1
fi

echo "Gateway version: ${GATEWAY_VERSION}"
echo ""

# ── 2. Installed extensions & peer alignment ─────────────────────────

echo "=== Installed Extensions ==="
if [[ -d "${EXTENSIONS_DIR}" ]]; then
    found_any=false
    for plugin_dir in "${EXTENSIONS_DIR}"/*/; do
        [[ ! -d "${plugin_dir}" ]] && continue

        plugin_name=$(basename "${plugin_dir}")

        # Skip backup directories created by install helpers
        [[ "${plugin_name}" == .* ]] && continue

        found_any=true

        # Plugin version from its own package.json
        pkg_file="${plugin_dir}package.json"
        if [[ -f "${pkg_file}" ]]; then
            plugin_version=$(json_value "${pkg_file}" "version")
        else
            plugin_version="(no package.json)"
        fi

        # Peer openclaw version (if bundled)
        peer_pkg="${plugin_dir}node_modules/openclaw/package.json"
        if [[ -f "${peer_pkg}" ]]; then
            peer_version=$(json_value "${peer_pkg}" "version")

            if [[ "${peer_version}" == "${GATEWAY_VERSION}" ]]; then
                peer_status="${GREEN}✓ MATCH${NC}"
            else
                peer_status="${RED}✗ MISMATCH (peer: ${peer_version}, gateway: ${GATEWAY_VERSION})${NC}"
                ISSUES=$((ISSUES + 1))
            fi
        else
            peer_status="${YELLOW}(no bundled openclaw peer — local plugin)${NC}"
        fi

        echo -e "  ${plugin_name} v${plugin_version}"
        echo -e "    Peer openclaw: ${peer_status}"

        # Hint if an npm update is available
        if [[ -f "${pkg_file}" ]] && command -v npm >/dev/null 2>&1; then
            pkg_name=$(json_value "${pkg_file}" "name")
            if [[ -n "${pkg_name}" && "${pkg_name}" != "unknown" ]]; then
                npm_latest=$(npm view "${pkg_name}" version 2>/dev/null || echo "")
                if [[ -n "${npm_latest}" && "${npm_latest}" != "${plugin_version}" ]]; then
                    echo -e "    ${YELLOW}⚠ npm latest: ${npm_latest} (update available)${NC}"
                fi
            fi
        fi
        echo ""
    done

    if [[ "${found_any}" == "false" ]]; then
        echo "  (no extensions installed)"
        echo ""
    fi
else
    echo "  No extensions directory found at ${EXTENSIONS_DIR}"
    echo ""
fi

# ── 3. LCM database health (optional — only if LCM plugin present) ──

echo "=== LCM Database Health ==="
if [[ -f "${LCM_DB}" ]]; then
    echo "  Database: ${LCM_DB}"

    if ! command -v python3 &>/dev/null; then
        echo -e "  ${YELLOW}⚠ python3 not found — skipping DB inspection${NC}"
    else
        TABLES=$(LCM_DB_PATH="${LCM_DB}" python3 - <<'PYEOF'
import sqlite3, sys, os
try:
    conn = sqlite3.connect(os.environ['LCM_DB_PATH'])
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%' ORDER BY name")
    print(','.join(r[0] for r in cur.fetchall()))
    conn.close()
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
PYEOF
)

        if [[ -z "${TABLES}" ]]; then
            echo -e "  ${RED}✗ No tables found or DB access error${NC}"
            ISSUES=$((ISSUES + 1))
        else
            echo "  Tables: ${TABLES}"

            for table in conversations messages summaries; do
                if echo "${TABLES}" | grep -qw "${table}"; then
                    count=$(LCM_DB_PATH="${LCM_DB}" LCM_TABLE="${table}" python3 - <<'PYEOF'
import sqlite3, os
conn = sqlite3.connect(os.environ['LCM_DB_PATH'])
print(conn.execute(f"SELECT COUNT(*) FROM {os.environ['LCM_TABLE']}").fetchone()[0])
conn.close()
PYEOF
)
                    echo "  ${table}: ${count:-?} rows"
                fi
            done

            echo -e "  ${GREEN}✓ LCM database accessible${NC}"
        fi
    fi
else
    echo "  No LCM database found (LCM plugin may not be installed — this is fine)"
fi
echo ""

# ── 4. Plugin load status ────────────────────────────────────────────

echo "=== Plugin Load Status ==="
if command -v openclaw >/dev/null 2>&1; then
    # Prefer structured JSON output when available
    PLUGIN_OUTPUT=$(openclaw plugins list --json 2>/dev/null || openclaw plugins list 2>&1 || true)
    if [[ -n "${PLUGIN_OUTPUT}" ]]; then
        echo "${PLUGIN_OUTPUT}" \
          | grep -iE "(loaded|initialized|error|fail|\"name\"|\"status\")" \
          || echo "  (no recognizable status lines)"
    else
        echo "  (could not query plugin status)"
    fi
else
    echo "  (openclaw not in PATH — cannot query plugin status)"
fi
echo ""

# ── 5. Summary ───────────────────────────────────────────────────────

echo "=== Summary ==="
if [[ "${ISSUES}" -eq 0 ]]; then
    echo -e "${GREEN}✓ All checks passed${NC}"
    exit 0
else
    echo -e "${RED}✗ ${ISSUES} issue(s) found${NC}"
    echo ""
    echo "Remediation:"
    echo "  Peer mismatch →  cd ${EXTENSIONS_DIR}/<plugin>"
    echo "                   npm install openclaw@${GATEWAY_VERSION}"
    echo "                   openclaw gateway restart"
    exit 1
fi
