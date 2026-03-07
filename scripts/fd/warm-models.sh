#!/usr/bin/env bash
# Pre-warm Ollama models on M1 Mac Studio
# Loads models into memory so first inference is fast
set -euo pipefail

OLLAMA_HOST="${OLLAMA_PRIMARY_HOST:-http://127.0.0.1:11434}"

echo "Warming Ollama models on M1 ($OLLAMA_HOST)..."

# Check Ollama is running
if ! curl -sf "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
    echo "ERROR: Ollama not responding at $OLLAMA_HOST"
    echo "  Start with: ollama serve"
    exit 1
fi

# Models to warm (in priority order)
MODELS=(
    "qwen3.5:9b"    # Primary workhorse
    "qwen3.5:4b"    # Fast helper
)

for model in "${MODELS[@]}"; do
    echo -n "  Loading $model... "

    # Check if model exists locally
    if ! curl -sf "$OLLAMA_HOST/api/show" -d "{\"name\": \"$model\"}" >/dev/null 2>&1; then
        echo "PULLING (first time)"
        curl -sf "$OLLAMA_HOST/api/pull" -d "{\"name\": \"$model\", \"stream\": false}" >/dev/null 2>&1 || {
            echo "FAILED to pull $model"
            continue
        }
    fi

    # Generate a tiny prompt to load model into memory
    response=$(curl -sf "$OLLAMA_HOST/api/generate" \
        -d "{\"model\": \"$model\", \"prompt\": \"hi\", \"stream\": false}" 2>/dev/null)

    if [[ $? -eq 0 ]]; then
        echo "OK (loaded into memory)"
    else
        echo "FAILED"
    fi
done

echo ""
echo "Model warm-up complete."
echo "  Check loaded models: curl $OLLAMA_HOST/api/ps"
