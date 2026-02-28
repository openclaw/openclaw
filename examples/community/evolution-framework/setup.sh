#!/bin/bash
# Quick setup script for OpenClaw Evolution Framework

set -e  # Exit on error

echo "🌳 OpenClaw Evolution Framework - Quick Setup"
echo "=============================================="
echo ""

# Check if OpenClaw is installed
if ! command -v openclaw &> /dev/null; then
    echo "❌ Error: OpenClaw is not installed"
    echo ""
    echo "Please install OpenClaw first:"
    echo "  npm install -g openclaw@latest"
    echo ""
    exit 1
fi

echo "✅ OpenClaw is installed"
echo ""

# Check OpenClaw version
OPENCLAW_VERSION=$(openclaw --version 2>&1 || echo "unknown")
echo "Version: $OPENCLAW_VERSION"
echo ""

# Copy example config
if [ ! -f "evolution-config.yaml" ]; then
    echo "📝 Creating evolution-config.yaml from example..."
    cp evolution-config.example.yaml evolution-config.yaml
    echo "✅ Config file created"
else
    echo "⚠️  evolution-config.yaml already exists, skipping"
fi
echo ""

# Create memory directory
echo "📁 Creating memory/evolution directory..."
mkdir -p memory/evolution
echo "✅ Directory created"
echo ""

# Add cron job
echo "⏰ Adding cron job..."
if openclaw cron list 2>&1 | grep -q "evolution-fast-loop"; then
    echo "⚠️  Cron job already exists"
else
    openclaw cron add --file cron-evolution-job.json
    echo "✅ Cron job added"
fi
echo ""

# Summary
echo "=============================================="
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit evolution-config.yaml (customize your themes)"
echo "2. Run: openclaw cron run evolution-fast-loop"
echo "3. Check outputs in: memory/evolution/"
echo ""
echo "For more info: cat README.md"
echo ""
