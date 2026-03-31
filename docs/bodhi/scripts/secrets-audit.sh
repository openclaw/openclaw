#!/usr/bin/env bash
# secrets-audit.sh
# Monthly reminder to rotate API keys and check for leaked secrets.
# Called by OpenClaw cron on the 1st of each month.
# Always prints a report — this is not a silent health check.

set -euo pipefail

ENV_FILE="${HOME}/.openclaw/.env"
STATE_FILE="${HOME}/.openclaw/budget-state.json"
VAULT_DIR="${HOME}/openbodhi/vault"

echo "SECRETS_AUDIT_REPORT"
echo "---"

# Check .env exists and is not world-readable
if [[ -f "$ENV_FILE" ]]; then
    PERMS=$(stat -c "%a" "$ENV_FILE" 2>/dev/null || stat -f "%A" "$ENV_FILE" 2>/dev/null || echo "unknown")
    if [[ "$PERMS" != "600" && "$PERMS" != "unknown" ]]; then
        echo "WARN: .env permissions are $PERMS (should be 600). Fix: chmod 600 ~/.openclaw/.env"
    else
        echo "OK: .env permissions: $PERMS"
    fi
else
    echo "WARN: .env not found at $ENV_FILE"
fi

# Check for .env or secrets files in git
if git -C "${HOME}/openbodhi" diff --name-only HEAD 2>/dev/null | grep -qiE '\.env|secret|token|key'; then
    echo "WARN: Possible secret file staged for commit in openbodhi repo"
else
    echo "OK: No secret files detected in git staging area"
fi

# Check vault dir permissions
if [[ -d "$VAULT_DIR" ]]; then
    VPERMS=$(stat -c "%a" "$VAULT_DIR" 2>/dev/null || echo "unknown")
    if [[ "$VPERMS" == "700" || "$VPERMS" == "unknown" ]]; then
        echo "OK: vault directory permissions: $VPERMS"
    else
        echo "WARN: vault directory permissions are $VPERMS (should be 700). Fix: chmod 700 ~/openbodhi/vault"
    fi
fi

echo "---"
echo "ACTION: Review Bitwarden for keys due rotation (Telegram bot, Anthropic API, Hetzner S3, Twenty CRM, Mautic OAuth)"
echo "REMINDER: Twenty CRM token expires 2125 — verify it is still generating sub-tokens correctly"
