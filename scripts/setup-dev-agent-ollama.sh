#!/bin/bash
# Helper script to set up dev agent with Ollama
# This sets OLLAMA_API_KEY and configures the dev agent to use Ollama models

set -e

echo "Setting up Ollama for dev agent..."

# Set OLLAMA_API_KEY (can be any value for local Ollama)
export OLLAMA_API_KEY="ollama-local"

# Check if Ollama is running
if ! curl -s http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
  echo "⚠️  Warning: Ollama doesn't seem to be running at http://127.0.0.1:11434"
  echo "   Please start Ollama first: ollama serve"
  exit 1
fi

echo "✓ Ollama is running"

# List available models
echo ""
echo "Available Ollama models:"
ollama list | grep -E "^(NAME|deepseek|gemma|gpt-oss)" || ollama list

# Configure dev agent to use gemma3:12b (or another model)
MODEL="${1:-ollama/gemma3:12b}"
echo ""
echo "Configuring dev agent to use: $MODEL"

cd /Users/zhyr/work/openclaw
pnpm openclaw --dev config set agents.list.0.model.primary "$MODEL" 2>&1 | grep -E "(Updated|Error|Config)" || true

echo ""
echo "✓ Configuration updated!"
echo ""
echo "To use Ollama, make sure OLLAMA_API_KEY is set when running gateway:"
echo "  export OLLAMA_API_KEY=\"ollama-local\""
echo "  pnpm openclaw --dev gateway run"
echo ""
echo "Or add to your shell profile (~/.zshrc or ~/.bashrc):"
echo "  export OLLAMA_API_KEY=\"ollama-local\""
