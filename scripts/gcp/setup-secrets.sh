#!/usr/bin/env bash
# Create GCP Secret Manager secrets for OpenClaw Cloud Run deployment.
#
# Usage:
#   ./scripts/gcp/setup-secrets.sh <project-id>
#
# This script creates empty secret entries. After running it, populate each
# secret with:
#   echo -n 'YOUR_VALUE' | gcloud secrets versions add SECRET_NAME \
#     --data-file=- --project=<project-id>
#
# Then reference them in Cloud Run with --set-secrets (see cloudbuild.yaml).

set -euo pipefail

PROJECT_ID="${1:?Usage: setup-secrets.sh <project-id>}"

echo "Enabling Secret Manager API..."
gcloud services enable secretmanager.googleapis.com --project="${PROJECT_ID}"

# Required secrets
SECRETS=(
  "openclaw-gateway-token:OPENCLAW_GATEWAY_TOKEN"
)

# Optional secrets — uncomment the ones you need:
# SECRETS+=(
#   "anthropic-api-key:ANTHROPIC_API_KEY"
#   "openai-api-key:OPENAI_API_KEY"
#   "gemini-api-key:GEMINI_API_KEY"
#   "openrouter-api-key:OPENROUTER_API_KEY"
#   "telegram-bot-token:TELEGRAM_BOT_TOKEN"
#   "discord-bot-token:DISCORD_BOT_TOKEN"
#   "slack-bot-token:SLACK_BOT_TOKEN"
#   "slack-app-token:SLACK_APP_TOKEN"
# )

echo ""
echo "Creating secrets in project: ${PROJECT_ID}"
echo "---"

for entry in "${SECRETS[@]}"; do
  secret_name="${entry%%:*}"
  env_var="${entry##*:}"

  if gcloud secrets describe "${secret_name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "  ${secret_name} (${env_var}) — already exists"
  else
    gcloud secrets create "${secret_name}" \
      --project="${PROJECT_ID}" \
      --replication-policy="automatic"
    echo "  ${secret_name} (${env_var}) — created"
  fi
done

echo ""
echo "==> Next steps"
echo ""
echo "1. Set secret values:"
echo ""
for entry in "${SECRETS[@]}"; do
  secret_name="${entry%%:*}"
  echo "   echo -n 'YOUR_VALUE' | gcloud secrets versions add ${secret_name} \\"
  echo "     --data-file=- --project=${PROJECT_ID}"
  echo ""
done
echo "2. Map secrets to Cloud Run env vars in your deploy command:"
echo ""
echo "   gcloud run services update openclaw-gateway \\"
echo "     --region=us-central1 \\"
for entry in "${SECRETS[@]}"; do
  secret_name="${entry%%:*}"
  env_var="${entry##*:}"
  echo "     --set-secrets=${env_var}=${secret_name}:latest \\"
done
echo "     --project=${PROJECT_ID}"
