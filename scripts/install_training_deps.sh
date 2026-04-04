#!/bin/bash
# install_training_deps.sh — Install cloud training pipeline dependencies
# Run: bash scripts/install_training_deps.sh

set -e

cd "$(dirname "$0")/.."

echo "=== Installing OpenClaw Cloud Training Dependencies ==="

# Use project venv
if [ -f .venv/bin/activate ]; then
    source .venv/bin/activate
elif [ -f .venv/Scripts/activate ]; then
    source .venv/Scripts/activate
fi

echo "Python: $(python --version)"
echo ""

echo "[1/2] Installing core dependencies..."
python -m pip install aiohttp>=3.9 -q

echo "[2/2] Verifying installation..."
python -c "
import aiohttp; print('aiohttp:', aiohttp.__version__)
import json; print('json: OK')
import asyncio; print('asyncio: OK')
"

echo ""
echo "=== Cloud training deps installed! ==="
echo ""
echo "Usage:"
echo "  python scripts/train_lora.py generate --count 20"
echo "  python scripts/train_lora.py improve  --dataset data/training/raw_dialogues.jsonl"
echo "  python scripts/train_lora.py evaluate --dataset data/training/raw_dialogues.jsonl"
echo ""
echo "Next: collect data with:"
echo "  python /mnt/d/openclaw_bot/openclaw_bot/scripts/collect_training_data.py"
