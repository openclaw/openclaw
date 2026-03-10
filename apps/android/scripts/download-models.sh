#!/bin/bash
# Download sherpa-onnx models with retry logic
set -e

ASSETS_DIR="/home/iouoi/openclaw/apps/android/app/src/main/assets/sherpa-onnx"
ASR_DIR="$ASSETS_DIR/asr"
TTS_DIR="$ASSETS_DIR/tts"

mkdir -p "$ASR_DIR" "$TTS_DIR"

# Model URLs
ASR_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en-2023-02-20.tar.bz2"
TTS_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2"

download_with_retry() {
    local url="$1"
    local output="$2"
    local max_retries=5
    local retry_count=0

    while [ $retry_count -lt $max_retries ]; do
        echo "Downloading $url (attempt $((retry_count + 1))/$max_retries)..."

        if curl -L -o "$output" "$url" --max-time 1800 --connect-timeout 30; then
            echo "Download successful: $output"
            return 0
        else
            retry_count=$((retry_count + 1))
            if [ $retry_count -lt $max_retries ]; then
                echo "Download failed, retrying in 5 seconds..."
                sleep 5
            fi
        fi
    done

    echo "Failed to download after $max_retries attempts: $url"
    return 1
}

# Download ASR model
echo "=== Downloading ASR model ==="
if [ ! -d "$ASR_DIR/exp" ]; then
    download_with_retry "$ASR_URL" "/tmp/asr-model.tar.bz2"
    echo "Extracting ASR model..."
    mkdir -p /tmp/asr-extract
    tar -xjf /tmp/asr-model.tar.bz2 -C /tmp/asr-extract
    mv /tmp/asr-extract/sherpa-onnx-streaming-paraformer-bilingual-zh-en-2023-02-20/* "$ASR_DIR/"
    rm -rf /tmp/asr-extract /tmp/asr-model.tar.bz2
    echo "ASR model installed to: $ASR_DIR"
else
    echo "ASR model already exists, skipping..."
fi

# Download TTS model
echo "=== Downloading TTS model ==="
if [ ! -d "$TTS_DIR/exp" ]; then
    download_with_retry "$TTS_URL" "/tmp/tts-model.tar.bz2"
    echo "Extracting TTS model..."
    mkdir -p /tmp/tts-extract
    tar -xjf /tmp/tts-model.tar.bz2 -C /tmp/tts-extract
    mv /tmp/tts-extract/vits-icefall-zh-aishell3/* "$TTS_DIR/"
    rm -rf /tmp/tts-extract /tmp/tts-model.tar.bz2
    echo "TTS model installed to: $TTS_DIR"
else
    echo "TTS model already exists, skipping..."
fi

echo "=== Model download complete ==="
ls -la "$ASR_DIR" | head -20
ls -la "$TTS_DIR" | head -20
