#!/bin/bash
# railway-deploy.sh - Deploy OpenClaw ECC to Railway.app
# This is the EASIEST method since you can't find file upload in ClawCloud

set -e

echo "🚀 OpenClaw ECC - Railway Deployment (Easiest Method)"
echo "========================================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}This will deploy to Railway.app (simpler than ClawCloud)${NC}"
echo ""

# Check if railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "Installing Railway CLI..."
    npm install -g @railway/cli
fi

# Login
railway login

# Create project
echo "Creating Railway project..."
railway init

# Add environment variables
echo "Adding environment variables..."
railway variables set NVIDIA_API_KEY="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"
railway variables set DATABASE_URL="https://ep-blue-morning-a1zjgpm2.apirest.ap-southeast-1.aws.neon.tech/neondb/rest/v1"
railway variables set REDIS_URL="https://open-bullfrog-15428.upstash.io"
railway variables set NODE_ENV="production"
railway variables set GATEWAY_PORT="3000"

# Set start command
echo "Setting start command..."
railway up --detach

echo ""
echo -e "${GREEN}✅ Deployment initiated!${NC}"
echo ""
echo "Your app will be live at:"
echo "  https://<project-name>.up.railway.app"
echo ""
echo "Check status with: railway status"
echo "View logs with: railway logs"
echo ""
echo "Test with:"
echo "  curl https://<your-url>.up.railway.app/health"
