#!/usr/bin/env bash
# set-iam-bindings.sh — Set per-secret IAM bindings for agent isolation
#
# This script enforces that each agent can ONLY read its own secrets.
# Access is controlled at the GCP IAM level — not application code.
#
# Naming convention:
#   openclaw-main-*    → only main agent SA can read
#   openclaw-chai-*    → only chai agent SA can read
#   openclaw-shared-*  → all agent SAs can read
#
# Prerequisites:
#   - Service accounts created (run bootstrap-gcp.sh first)
#   - Compute SA has roles/secretmanager.admin
#
# Usage:
#   ./set-iam-bindings.sh <project-id> <agent1,agent2,...>
#
# Example:
#   ./set-iam-bindings.sh my-project main,chai

set -euo pipefail

PROJECT="${1:?Usage: $0 <project-id> <agent1,agent2,...>}"
AGENTS="${2:?Usage: $0 <project-id> <agent1,agent2,...>}"

echo "═══════════════════════════════════════════════════"
echo "  OpenClaw Per-Secret IAM Bindings"
echo "  Project: $PROJECT"
echo "  Agents:  $AGENTS"
echo "═══════════════════════════════════════════════════"
echo ""

IFS=',' read -ra AGENT_LIST <<< "$AGENTS"

# ---------------------------------------------------------------------------
# List all secrets
# ---------------------------------------------------------------------------

echo "--- Fetching secrets ---"
SECRETS=$(gcloud secrets list --project="$PROJECT" --format="value(name)" 2>/dev/null)

if [[ -z "$SECRETS" ]]; then
  echo "No secrets found in project $PROJECT."
  exit 0
fi

echo "$SECRETS" | while read -r secret; do echo "  $secret"; done
echo ""

# ---------------------------------------------------------------------------
# Set bindings
# ---------------------------------------------------------------------------

echo "--- Setting IAM bindings ---"
echo ""

set_binding() {
  local secret="$1" agent="$2"
  local sa="serviceAccount:openclaw-${agent}@${PROJECT}.iam.gserviceaccount.com"

  gcloud secrets add-iam-policy-binding "$secret" \
    --project="$PROJECT" \
    --member="$sa" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet 2>/dev/null
}

while read -r SECRET_NAME; do
  [[ -z "$SECRET_NAME" ]] && continue

  # Determine which agent(s) should have access based on naming convention
  if [[ "$SECRET_NAME" == openclaw-shared-* ]]; then
    # Shared secrets → all agents get access
    echo -n "  $SECRET_NAME → shared ("
    for AGENT in "${AGENT_LIST[@]}"; do
      set_binding "$SECRET_NAME" "$AGENT"
      echo -n "$AGENT "
    done
    echo ") ✅"

  else
    # Agent-specific secrets → match by prefix
    MATCHED=false
    for AGENT in "${AGENT_LIST[@]}"; do
      if [[ "$SECRET_NAME" == openclaw-${AGENT}-* ]]; then
        echo -n "  $SECRET_NAME → $AGENT only... "
        set_binding "$SECRET_NAME" "$AGENT"
        echo "✅"
        MATCHED=true
        break
      fi
    done

    if [[ "$MATCHED" == false ]]; then
      echo "  $SECRET_NAME → ⚠️  no matching agent (skipped)"
    fi
  fi

done <<< "$SECRETS"

echo ""

# ---------------------------------------------------------------------------
# Verify isolation
# ---------------------------------------------------------------------------

echo "--- Verifying isolation ---"
echo ""
echo "To verify, run this test (requires Node.js + tsx):"
echo ""
cat << 'VERIFY'
  node --import tsx -e "
  import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

  async function test(saFile, secretName) {
    const client = new SecretManagerServiceClient({ keyFilename: saFile });
    try {
      await client.accessSecretVersion({
        name: \`projects/PROJECT/secrets/\${secretName}/versions/latest\`
      });
      return '✅ access granted';
    } catch (e) {
      return e.code === 7 ? '🔒 PERMISSION_DENIED' : '❌ ' + e.message;
    }
  }

  // Test: main reads main secret (should work)
  console.log('main → main-*:', await test('~/.config/gcp/openclaw-main-sa.json', 'openclaw-main-SECRET'));
  // Test: main reads chai secret (should be blocked)
  console.log('main → chai-*:', await test('~/.config/gcp/openclaw-main-sa.json', 'openclaw-chai-SECRET'));
  // Test: chai reads chai secret (should work)
  console.log('chai → chai-*:', await test('~/.config/gcp/openclaw-chai-sa.json', 'openclaw-chai-SECRET'));
  // Test: chai reads main secret (should be blocked)
  console.log('chai → main-*:', await test('~/.config/gcp/openclaw-chai-sa.json', 'openclaw-main-SECRET'));
  "
VERIFY

echo ""
echo "(Replace PROJECT and SECRET with your actual values)"
echo ""
echo "═══════════════════════════════════════════════════"
echo "  IAM bindings set!"
echo "  Each agent can only read secrets with its prefix."
echo "═══════════════════════════════════════════════════"
