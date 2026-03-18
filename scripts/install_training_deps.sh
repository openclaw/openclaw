#!/bin/bash
# install_training_deps.sh — Install LoRA training stack into WSL vLLM venv
# Run from WSL: bash /mnt/d/openclaw_bot/openclaw_bot/scripts/install_training_deps.sh

set -e
VENV="/mnt/d/vllm_env"

echo "=== Installing OpenClaw Training Dependencies ==="
echo "Target venv: $VENV"
echo ""

source "$VENV/bin/activate"
echo "Python: $(python --version)"
echo "CUDA:   $(python -c 'import torch; print(torch.version.cuda)' 2>/dev/null || echo 'torch not found')"
echo ""

echo "[1/5] Upgrading pip..."
pip install --upgrade pip -q

echo "[2/5] Installing bitsandbytes (4-bit quantization)..."
pip install bitsandbytes>=0.45 -q

echo "[3/5] Installing peft (LoRA mechanism)..."
pip install peft>=0.14 -q

echo "[4/5] Installing trl (SFTTrainer, DPOTrainer)..."
pip install trl>=0.15 -q

echo "[5/5] Installing unsloth (2-4x faster training + VRAM savings)..."
pip install "unsloth[cu124] @ git+https://github.com/unslothai/unsloth.git" -q

echo ""
echo "[+] Installing datasets and wandb..."
pip install datasets>=3.0 wandb -q

echo ""
echo "=== Verifying installation ==="
python -c "
import peft; print('peft:', peft.__version__)
import trl;  print('trl:', trl.__version__)
import datasets; print('datasets:', datasets.__version__)
try:
    import unsloth; print('unsloth: OK')
except ImportError as e:
    print('unsloth: FAILED —', e)
"

echo ""
echo "✅ Training dependencies installed!"
echo ""
echo "Next: collect data with:"
echo "  python /mnt/d/openclaw_bot/openclaw_bot/scripts/collect_training_data.py"
