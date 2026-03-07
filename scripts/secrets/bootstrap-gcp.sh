#!/usr/bin/env bash
# bootstrap-gcp.sh — Set up GCP Secret Manager for OpenClaw
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - A GCP project with billing enabled
#   - Compute Engine VM with cloud-platform OAuth scope
#
# Usage:
#   ./bootstrap-gcp.sh <project-id> [agent1,agent2,...]
#
# Example:
#   ./bootstrap-gcp.sh my-project main,chai

set -euo pipefail

PROJECT="${1:?Usage: $0 <project-id> [agent1,agent2,...]}"
AGENTS="${2:-main}"
SA_KEY_DIR="${SA_KEY_DIR:-$HOME/.config/gcp}"

echo "═══════════════════════════════════════════════════"
echo "  OpenClaw GCP Secret Manager Bootstrap"
echo "  Project: $PROJECT"
echo "  Agents:  $AGENTS"
echo "═══════════════════════════════════════════════════"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Enable required APIs
# ---------------------------------------------------------------------------
echo "--- Step 1: Enabling APIs ---"

for API in secretmanager.googleapis.com iam.googleapis.com cloudresourcemanager.googleapis.com; do
  echo -n "  Enabling $API... "
  if gcloud services enable "$API" --project="$PROJECT" 2>/dev/null; then
    echo "✅"
  else
    # Fallback: use REST API (for VMs with scope issues on gcloud)
    TOKEN=$(curl -s 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
      -H 'Metadata-Flavor: Google' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
    curl -s -X POST -H "Authorization: Bearer $TOKEN" \
      "https://serviceusage.googleapis.com/v1/projects/$PROJECT/services/$API:enable" > /dev/null
    echo "✅ (via REST API)"
  fi
done

echo ""

# ---------------------------------------------------------------------------
# Step 2: Grant compute SA the required roles
# ---------------------------------------------------------------------------
echo "--- Step 2: IAM roles for compute service account ---"
echo ""
echo "⚠️  The compute service account needs these roles."
echo "   Run these from your LOCAL machine (not the VM) — VMs cannot"
echo "   modify their own IAM policies."
echo ""

COMPUTE_SA=$(curl -s 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email' \
  -H 'Metadata-Flavor: Google' 2>/dev/null || echo "<compute-sa-email>")

cat << EOF
   # Read secrets at runtime
   gcloud projects add-iam-policy-binding $PROJECT \\
     --member="serviceAccount:$COMPUTE_SA" \\
     --role="roles/secretmanager.secretAccessor"

   # Manage secrets and per-agent IAM bindings
   gcloud projects add-iam-policy-binding $PROJECT \\
     --member="serviceAccount:$COMPUTE_SA" \\
     --role="roles/secretmanager.admin"

   Or via GCP Console:
   1. Go to IAM & Admin → IAM
   2. Find: $COMPUTE_SA
   3. Edit → Add roles:
      • Secret Manager Secret Accessor
      • Secret Manager Admin
   4. Save

EOF

read -p "Press Enter once you've granted these roles (or Ctrl+C to abort)... "
echo ""

# ---------------------------------------------------------------------------
# Step 3: Create per-agent service accounts
# ---------------------------------------------------------------------------
echo "--- Step 3: Creating per-agent service accounts ---"

mkdir -p "$SA_KEY_DIR"

IFS=',' read -ra AGENT_LIST <<< "$AGENTS"
for AGENT in "${AGENT_LIST[@]}"; do
  SA_EMAIL="openclaw-${AGENT}@${PROJECT}.iam.gserviceaccount.com"
  SA_KEY_FILE="$SA_KEY_DIR/openclaw-${AGENT}-sa.json"

  echo -n "  Creating openclaw-${AGENT}... "
  if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" &>/dev/null; then
    echo "already exists"
  else
    gcloud iam service-accounts create "openclaw-${AGENT}" \
      --display-name="OpenClaw ${AGENT} agent" \
      --project="$PROJECT" 2>/dev/null
    echo "✅"
  fi

  echo -n "  Generating key → $SA_KEY_FILE... "
  if [[ -f "$SA_KEY_FILE" ]]; then
    echo "already exists (skipping)"
  else
    gcloud iam service-accounts keys create "$SA_KEY_FILE" \
      --iam-account="$SA_EMAIL" 2>/dev/null
    chmod 600 "$SA_KEY_FILE"
    echo "✅"
  fi
done

echo ""

# ---------------------------------------------------------------------------
# Step 4: Summary
# ---------------------------------------------------------------------------
echo "--- Setup Complete ---"
echo ""
echo "Service accounts created:"
for AGENT in "${AGENT_LIST[@]}"; do
  echo "  • openclaw-${AGENT}@${PROJECT}.iam.gserviceaccount.com"
  echo "    Key: $SA_KEY_DIR/openclaw-${AGENT}-sa.json"
done
echo ""
echo "Next steps:"
echo "  1. Store secrets:        ./scripts/migrate-secrets.sh $PROJECT"
echo "  2. Set IAM bindings:     ./scripts/set-iam-bindings.sh $PROJECT $AGENTS"
echo "  3. Update openclaw.json: add secrets.providers.gcp config with credentialsFile"
echo ""
