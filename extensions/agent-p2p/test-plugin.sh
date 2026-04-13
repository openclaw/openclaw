#!/bin/bash

# Agent P2P Plugin Test Script

echo "🧪 Agent P2P Plugin Test Environment"
echo "======================================"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Please install Docker first."
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose not found. Please install Docker Compose first."
    exit 1
fi

echo ""
echo "📦 Building test environment..."
docker-compose -f docker-compose.test.yml build

echo ""
echo "🚀 Starting services..."
docker-compose -f docker-compose.test.yml up -d

echo ""
echo "⏳ Waiting for services to start..."
sleep 10

echo ""
echo "🔍 Checking service status..."
docker-compose -f docker-compose.test.yml ps

echo ""
echo "📝 Viewing OpenClaw logs..."
docker-compose -f docker-compose.test.yml logs --tail=50 openclaw-agent-p2p

echo ""
echo "✅ Test environment is ready!"
echo ""
echo "Useful commands:"
echo "  - View logs: docker-compose -f docker-compose.test.yml logs -f"
echo "  - Stop: docker-compose -f docker-compose.test.yml down"
echo "  - Restart: docker-compose -f docker-compose.test.yml restart"
echo ""
echo "OpenClaw Gateway: http://localhost:18789"
echo "Mock Portal WebSocket: ws://localhost:8080"
