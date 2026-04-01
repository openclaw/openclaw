#!/bin/bash

# Deploy Shopify MCP Server to DigitalOcean Droplet
# This script builds and deploys the HTTP-based Shopify MCP server

set -e

echo "🚀 Deploying Shopify MCP Server to Droplet..."

# Configuration
DROPLET_IP="157.230.13.13"
DROPLET_USER="root"
SSH_KEY="~/.ssh/digitalocean"
REMOTE_DIR="/opt/mcp-servers/shopify-mcp-server"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}📦 Preparing files for deployment...${NC}"

# Create deployment package
TEMP_DIR=$(mktemp -d)
echo "Using temp directory: $TEMP_DIR"

# Copy necessary files
cp -r package*.json tsconfig.json src build "$TEMP_DIR/"
cp Dockerfile .dockerignore "$TEMP_DIR/" 2>/dev/null || true

# Create deployment archive
cd "$TEMP_DIR"
tar -czf shopify-mcp-deploy.tar.gz *
cd -

echo -e "${GREEN}✅ Deployment package created${NC}"

echo -e "${YELLOW}📤 Uploading to droplet...${NC}"

# Upload to droplet
scp -i "$SSH_KEY" "$TEMP_DIR/shopify-mcp-deploy.tar.gz" "$DROPLET_USER@$DROPLET_IP:/tmp/"

echo -e "${GREEN}✅ Files uploaded${NC}"

echo -e "${YELLOW}🔧 Deploying on droplet...${NC}"

# Deploy on droplet
ssh -i "$SSH_KEY" "$DROPLET_USER@$DROPLET_IP" << 'ENDSSH'
set -e

# Create directory if it doesn't exist
mkdir -p /opt/mcp-servers/shopify-mcp-server
cd /opt/mcp-servers/shopify-mcp-server

# Extract files
tar -xzf /tmp/shopify-mcp-deploy.tar.gz
rm /tmp/shopify-mcp-deploy.tar.gz

# Stop existing service if running
systemctl stop shopify-mcp-http 2>/dev/null || true

# Build Docker image
docker build -t shopify-mcp:latest .

# Stop and remove existing container if it exists
docker stop shopify-mcp 2>/dev/null || true
docker rm shopify-mcp 2>/dev/null || true

# Load environment variables from main .env if it exists
if [ -f /root/vivid_mas/.env ]; then
    source /root/vivid_mas/.env
fi

# Set default values if not in .env
SHOPIFY_ACCESS_TOKEN="${SHOPIFY_ACCESS_TOKEN:-shpat_EXAMPLE_REPLACE_WITH_YOUR_TOKEN}"
MYSHOPIFY_DOMAIN="${MYSHOPIFY_DOMAIN:-vividwalls-2.myshopify.com}"

# Run the container
docker run -d \
  --name shopify-mcp \
  --restart unless-stopped \
  --network vivid_mas \
  -p 8081:8081 \
  -e PORT=8081 \
  -e SHOPIFY_ACCESS_TOKEN="$SHOPIFY_ACCESS_TOKEN" \
  -e MYSHOPIFY_DOMAIN="$MYSHOPIFY_DOMAIN" \
  shopify-mcp:latest

# Wait for container to start
sleep 5

# Check if container is running
if docker ps | grep -q shopify-mcp; then
    echo "✅ Shopify MCP container is running"
    
    # Test health endpoint
    if curl -s http://localhost:8081/health | grep -q "healthy"; then
        echo "✅ Health check passed"
    else
        echo "⚠️ Health check failed"
    fi
else
    echo "❌ Container failed to start"
    docker logs shopify-mcp
    exit 1
fi

echo "🎉 Deployment complete!"
ENDSSH

# Cleanup
rm -rf "$TEMP_DIR"

echo -e "${GREEN}🎉 Shopify MCP Server deployed successfully!${NC}"
echo -e "Access the server at: http://$DROPLET_IP:8081"
echo -e "Health check: http://$DROPLET_IP:8081/health"
echo -e "MCP endpoint: http://$DROPLET_IP:8081/mcp/v1/message"