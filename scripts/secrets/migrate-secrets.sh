#!/usr/bin/env bash
# migrate-secrets.sh — Migrate plaintext secrets to GCP Secret Manager
#
# This script:
#   1. Scans known credential locations for plaintext secrets
#   2. Stores each in GCP Secret Manager with agent-namespaced names
#   3. Verifies each secret can be retrieved
#   4. Replaces plaintext files with migration notes
#
# Prerequisites:
#   - GCP Secret Manager API enabled
#   - gcloud CLI authenticated with secretmanager.admin role
#   - bootstrap-gcp.sh already run
#
# Usage:
#   ./migrate-secrets.sh <project-id> [--yes]
#
# Example:
#   ./migrate-secrets.sh my-project
#   ./migrate-secrets.sh my-project --yes    # skip confirmations

set -euo pipefail

PROJECT="${1:?Usage: $0 <project-id> [--yes]}"
AUTO_YES="${2:-}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

store_secret() {
  local name="$1" value="$2"
  # Create secret (ignore if exists)
  gcloud secrets create "$name" --project="$PROJECT" --replication-policy=automatic 2>/dev/null || true
  # Add version
  echo -n "$value" | gcloud secrets versions add "$name" --project="$PROJECT" --data-file=- 2>/dev/null
}

verify_secret() {
  local name="$1" expected="$2"
  local actual
  actual=$(gcloud secrets versions access latest --secret="$name" --project="$PROJECT" 2>/dev/null)
  if [[ "$actual" == "$expected" ]]; then
    return 0
  else
    return 1
  fi
}

confirm() {
  if [[ "$AUTO_YES" == "--yes" ]]; then return 0; fi
  local msg="$1"
  read -p "$msg [y/N] " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]]
}

# ---------------------------------------------------------------------------
# Scan for secrets
# ---------------------------------------------------------------------------

echo "═══════════════════════════════════════════════════"
echo "  OpenClaw Secret Migration"
echo "  Project: $PROJECT"
echo "═══════════════════════════════════════════════════"
echo ""
echo "--- Scanning for plaintext secrets ---"
echo ""

declare -A SECRETS_TO_MIGRATE

# OpenAI
if [[ -f "$HOME/.config/openai/credentials.env" ]]; then
  val=$(grep '^OPENAI_API_KEY=' "$HOME/.config/openai/credentials.env" 2>/dev/null | cut -d= -f2-)
  if [[ -n "$val" && "$val" != "#"* ]]; then
    SECRETS_TO_MIGRATE["openclaw-main-openai-api-key"]="$val"
    echo "  Found: OpenAI API Key → openclaw-main-openai-api-key"
  fi
fi

# Gemini
if [[ -f "$HOME/.config/google/gemini.env" ]]; then
  val=$(grep '^GEMINI_API_KEY=' "$HOME/.config/google/gemini.env" 2>/dev/null | cut -d= -f2-)
  if [[ -n "$val" && "$val" != "#"* ]]; then
    SECRETS_TO_MIGRATE["openclaw-main-gemini-api-key"]="$val"
    echo "  Found: Gemini API Key → openclaw-main-gemini-api-key"
  fi
fi

# Alpaca
if [[ -f "$HOME/.config/alpaca/sandbox.env" ]]; then
  key_id=$(grep '^ALPACA_KEY_ID=' "$HOME/.config/alpaca/sandbox.env" 2>/dev/null | cut -d= -f2-)
  secret_key=$(grep '^ALPACA_SECRET_KEY=' "$HOME/.config/alpaca/sandbox.env" 2>/dev/null | cut -d= -f2-)
  if [[ -n "$key_id" && "$key_id" != "#"* ]]; then
    SECRETS_TO_MIGRATE["openclaw-chai-alpaca-key-id"]="$key_id"
    echo "  Found: Alpaca Key ID → openclaw-chai-alpaca-key-id"
  fi
  if [[ -n "$secret_key" && "$secret_key" != "#"* ]]; then
    SECRETS_TO_MIGRATE["openclaw-chai-alpaca-secret-key"]="$secret_key"
    echo "  Found: Alpaca Secret Key → openclaw-chai-alpaca-secret-key"
  fi
fi

# GitHub PAT
if [[ -f "$HOME/.git-credentials" ]]; then
  # Only extract PATs from github.com entries (ghp_ or gho_ prefix)
  pat=$(grep 'github\.com' "$HOME/.git-credentials" 2>/dev/null | grep -oP '://[^:]+:\Kghp_[^@]+' | head -1)
  if [[ -n "$pat" && "$pat" != "#"* ]]; then
    SECRETS_TO_MIGRATE["openclaw-main-github-pat"]="$pat"
    echo "  Found: GitHub PAT → openclaw-main-github-pat"
  fi
fi

# Email password (himalaya)
if [[ -f "$HOME/.config/himalaya/.nine30-pass" ]]; then
  val=$(cat "$HOME/.config/himalaya/.nine30-pass" 2>/dev/null)
  if [[ -n "$val" && "$val" != "#"* ]]; then
    SECRETS_TO_MIGRATE["openclaw-main-nine30-email-password"]="$val"
    echo "  Found: Email password → openclaw-main-nine30-email-password"
  fi
fi

echo ""

if [[ ${#SECRETS_TO_MIGRATE[@]} -eq 0 ]]; then
  echo "No plaintext secrets found to migrate."
  exit 0
fi

echo "Found ${#SECRETS_TO_MIGRATE[@]} secrets to migrate."
echo ""

# ---------------------------------------------------------------------------
# Store secrets
# ---------------------------------------------------------------------------

if ! confirm "Store ${#SECRETS_TO_MIGRATE[@]} secrets in GCP Secret Manager?"; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "--- Storing secrets ---"

STORED=()
FAILED=()

for name in "${!SECRETS_TO_MIGRATE[@]}"; do
  echo -n "  Storing $name... "
  if store_secret "$name" "${SECRETS_TO_MIGRATE[$name]}"; then
    echo "✅"
    STORED+=("$name")
  else
    echo "❌"
    FAILED+=("$name")
  fi
done

echo ""

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "❌ ${#FAILED[@]} secrets failed to store. Aborting (no plaintext purged)."
  exit 1
fi

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

echo "--- Verifying secrets ---"

VERIFY_FAILED=()
for name in "${STORED[@]}"; do
  echo -n "  Verifying $name... "
  if verify_secret "$name" "${SECRETS_TO_MIGRATE[$name]}"; then
    echo "✅"
  else
    echo "❌ MISMATCH"
    VERIFY_FAILED+=("$name")
  fi
done

echo ""

if [[ ${#VERIFY_FAILED[@]} -gt 0 ]]; then
  echo "❌ ${#VERIFY_FAILED[@]} secrets failed verification. Aborting (no plaintext purged)."
  exit 1
fi

# ---------------------------------------------------------------------------
# Purge plaintext
# ---------------------------------------------------------------------------

echo "All secrets stored and verified."
echo ""

if ! confirm "Purge plaintext files? (replaces contents with migration notes)"; then
  echo "Skipping purge. Secrets are stored in GCP but plaintext files remain."
  exit 0
fi

echo ""
echo "--- Purging plaintext ---"

purge_file() {
  local file="$1" secret_name="$2"
  echo "# Migrated to GCP Secret Manager ($PROJECT)" > "$file"
  echo "# Secret: $secret_name" >> "$file"
  echo "  Purged: $file"
}

# Only purge files where ALL secrets from that file were successfully migrated
[[ -v SECRETS_TO_MIGRATE["openclaw-main-openai-api-key"] ]] && \
  purge_file "$HOME/.config/openai/credentials.env" "openclaw-main-openai-api-key"

[[ -v SECRETS_TO_MIGRATE["openclaw-main-gemini-api-key"] ]] && \
  purge_file "$HOME/.config/google/gemini.env" "openclaw-main-gemini-api-key"

[[ -v SECRETS_TO_MIGRATE["openclaw-main-nine30-email-password"] ]] && \
  purge_file "$HOME/.config/himalaya/.nine30-pass" "openclaw-main-nine30-email-password"

[[ -v SECRETS_TO_MIGRATE["openclaw-main-github-pat"] ]] && \
  purge_file "$HOME/.git-credentials" "openclaw-main-github-pat"

if [[ -v SECRETS_TO_MIGRATE["openclaw-chai-alpaca-key-id"] ]]; then
  {
    grep '^ALPACA_BASE_URL=' "$HOME/.config/alpaca/sandbox.env" 2>/dev/null || true
    echo "# Keys migrated to GCP Secret Manager ($PROJECT)"
    echo "# openclaw-chai-alpaca-key-id"
    echo "# openclaw-chai-alpaca-secret-key"
  } > "$HOME/.config/alpaca/sandbox.env.tmp"
  mv "$HOME/.config/alpaca/sandbox.env.tmp" "$HOME/.config/alpaca/sandbox.env"
  echo "  Purged: $HOME/.config/alpaca/sandbox.env (kept ALPACA_BASE_URL)"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Migration complete!"
echo "  ${#STORED[@]} secrets stored in GCP Secret Manager"
echo "  Plaintext files purged"
echo "═══════════════════════════════════════════════════"
