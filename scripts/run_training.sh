#!/usr/bin/env bash
set -e
echo "=== OpenClaw Cloud Training Pipeline $(date) ==="

cd "$(dirname "$0")/.."

# Activate Python venv if available
if [ -f .venv/bin/activate ]; then
    source .venv/bin/activate
elif [ -f .venv/Scripts/activate ]; then
    source .venv/Scripts/activate
fi

MODE="${1:-generate}"
DATASET="data/training/raw_dialogues.jsonl"

case "$MODE" in
    generate)
        echo ">>> Generating synthetic training data..."
        python scripts/train_lora.py generate \
            --count 20 \
            --output data/training/synthetic_generated.jsonl
        ;;
    improve)
        echo ">>> Improving existing training data..."
        python scripts/train_lora.py improve \
            --dataset "$DATASET"
        ;;
    evaluate)
        echo ">>> Evaluating training data quality..."
        python scripts/train_lora.py evaluate \
            --dataset "$DATASET" \
            --threshold 5.0
        ;;
    all)
        echo ">>> Full pipeline: evaluate → improve → generate..."
        python scripts/train_lora.py evaluate --dataset "$DATASET" --threshold 5.0
        python scripts/train_lora.py improve --dataset "$DATASET"
        python scripts/train_lora.py generate --count 20
        ;;
    *)
        echo "Usage: $0 {generate|improve|evaluate|all}"
        exit 1
        ;;
esac

RC=$?
echo "=== Training pipeline finished $(date) EXIT_CODE=$RC ==="
