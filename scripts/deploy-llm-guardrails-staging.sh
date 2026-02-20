#!/bin/bash
#
# Staging Deployment Script — LLM Hooks & Guardrails
# 
# Usage: ./scripts/deploy-llm-guardrails-staging.sh
#

set -e

echo "=== LLM Guardrails Staging Deployment ==="
echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo ""

# Check environment variables
echo "Checking environment variables..."
MISSING_VARS=0

if [[ -z "$OPENAI_API_KEY" ]]; then
  echo "❌ OPENAI_API_KEY not set"
  MISSING_VARS=1
else
  echo "✅ OPENAI_API_KEY configured"
fi

if [[ -z "$HELICONE_API_KEY" ]]; then
  echo "⚠️  HELICONE_API_KEY not set (observability disabled)"
else
  echo "✅ HELICONE_API_KEY configured"
fi

if [[ $MISSING_VARS -eq 1 ]]; then
  echo ""
  echo "Error: Required environment variables missing"
  exit 1
fi

# Verify build
echo ""
echo "Verifying build..."
cd /home/i/moltbot
if ! npm run build > /dev/null 2>&1; then
  echo "❌ Build failed"
  exit 1
fi
echo "✅ Build verified"

# Run lint
echo ""
echo "Running lint checks..."
if ! npm run lint -- src/llm/ > /dev/null 2>&1; then
  echo "❌ Lint errors found"
  exit 1
fi
echo "✅ Lint passed"

# Create staging environment file
echo ""
echo "Creating staging environment..."
STAGING_DIR="/home/i/clawd/staging/llm-guardrails"
mkdir -p "$STAGING_DIR"

cat > "$STAGING_DIR/.env.staging" << EOF
# LLM Guardrails Staging Environment
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Required
OPENAI_API_KEY=$OPENAI_API_KEY

# Optional (for observability)
HELICONE_API_KEY=${HELICONE_API_KEY:-}

# Staging Configuration
STAGING_ENVIRONMENT=staging
STAGING_MEASUREMENT_WINDOW_MS=172800000
STAGING_ERROR_RATE_THRESHOLD=0.05
STAGING_ENABLE_CIRCUIT_BREAKERS=true
STAGING_ENABLE_SAFETY_FILTERS=true
STAGING_ENABLE_ERROR_TRACKING=true
STAGING_ENABLE_HELICONE=${HELICONE_API_KEY:+true}${HELICONE_API_KEY:-false}
STAGING_LOG_LEVEL=info
STAGING_METRICS_EXPORT_INTERVAL_MS=300000
EOF

echo "✅ Staging environment created: $STAGING_DIR/.env.staging"

# Create systemd service file (optional)
echo ""
echo "Creating systemd service template..."
cat > "$STAGING_DIR/llm-guardrails-staging.service" << 'EOF'
[Unit]
Description=LLM Guardrails Staging Service
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/home/i/moltbot
EnvironmentFile=/home/i/clawd/staging/llm-guardrails/.env.staging
ExecStart=/usr/bin/npx tsx src/llm/cli/index.ts measure --hours 48 --threshold 0.05
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=llm-guardrails-staging

[Install]
WantedBy=multi-user.target
EOF

echo "✅ Service template created: $STAGING_DIR/llm-guardrails-staging.service"

# Create monitoring script
echo ""
echo "Creating monitoring script..."
cat > "$STAGING_DIR/monitor.sh" << 'EOF'
#!/bin/bash
# Monitor LLM Guardrails staging deployment

cd /home/i/moltbot

source /home/i/clawd/staging/llm-guardrails/.env.staging

echo "=== LLM Guardrails Staging Monitor ==="
echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo ""

echo "Running health check..."
npx tsx src/llm/cli/index.ts health --format table

echo ""
echo "Current metrics:"
npx tsx src/llm/cli/index.ts export --format table

echo ""
echo "Decision gate status:"
npx tsx src/llm/cli/index.ts evaluate --format table
EOF

chmod +x "$STAGING_DIR/monitor.sh"
echo "✅ Monitor script created: $STAGING_DIR/monitor.sh"

# Create log directory
mkdir -p "$STAGING_DIR/logs"

# Summary
echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Staging directory: $STAGING_DIR"
echo ""
echo "Next steps:"
echo "  1. Start measurement: sudo systemctl start llm-guardrails-staging"
echo "  2. Or run manually: npx tsx src/llm/cli/index.ts measure --hours 48"
echo "  3. Monitor: $STAGING_DIR/monitor.sh"
echo "  4. View logs: journalctl -u llm-guardrails-staging -f"
echo ""
echo "After 48 hours, check decision gate:"
echo "  npx tsx src/llm/cli/index.ts evaluate"
echo ""
