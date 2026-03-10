#!/bin/bash
# Download ASR model using current URLs from sherpa-onnx
set -e

ASSETS_DIR="/home/iouoi/openclaw/apps/android/app/src/main/assets/sherpa-onnx"
ASR_DIR="$ASSETS_DIR/asr"

mkdir -p "$ASR_DIR"

echo "=== Searching for ASR model URLs ==="

# Try different model URLs that might work
ASR_MODELS=(
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.25/sherpa-onnx-streaming-paraformer-bilingual-zh-en-2023-02-20.tar.bz2"
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-zh-2023-03-28.tar.bz2"
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2"
    "https://modelscope.cn/models/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/master/sherpa-onnx-streaming-paraformer-bilingual-zh-en-2023-02-20.tar.bz2"
)

for url in "${ASR_MODELS[@]}"; do
    echo "Trying: $url"

    if curl -I -s -L "$url" | head -n 1 | grep -q "200"; then
        echo "Found working URL: $url"
        echo "Downloading ASR model..."

        if curl -L -o /tmp/asr-model.tar.bz2 "$url" --max-time 1800; then
            echo "Download successful"
            echo "Extracting..."

            mkdir -p /tmp/asr-extract
            tar -xjf /tmp/asr-model.tar.bz2 -C /tmp/asr-extract

            # Find and move the extracted directory
            extracted_dir=$(find /tmp/asr-extract -maxdepth 1 -type d ! -name /tmp/asr-extract | head -1)
            if [ -n "$extracted_dir" ]; then
                echo "Moving files from $extracted_dir to $ASR_DIR"
                cp -r "$extracted_dir"/* "$ASR_DIR/"
                rm -rf /tmp/asr-extract /tmp/asr-model.tar.bz2
                echo "ASR model installed successfully"
                ls -la "$ASR_DIR"
                exit 0
            fi
        fi
    else
        echo "URL not accessible"
    fi
done

echo "Failed to find working ASR model URL"
echo "Please check https://github.com/k2-fsa/sherpa-onnx/releases for available models"
