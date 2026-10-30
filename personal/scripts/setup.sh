#!/bin/bash
set -euo pipefail

echo "Setting up OpenClaw Personal Customization..."

mkdir -p ~/.openclaw/workspace
cp personal/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp personal/templates/USER.md ~/.openclaw/workspace/USER.md

# Copy config
mkdir -p ~/.openclaw/
cp personal/config/openclaw.example.json5 ~/.openclaw/openclaw.json

echo "Done! Please fill in placeholders in ~/.openclaw/workspace/SOUL.md"
