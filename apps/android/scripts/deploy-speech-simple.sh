#!/bin/bash
# Simplified deployment script for Whisper + Fish Speech on ub22
# Uses existing model files in /home/an/whisper.cpp/models and /home/an/fish-speech

set -e

UB22_HOST="ub22"

echo "=== Deploying Whisper + Fish Speech Services ==="

# Create deployment directory
ssh $UB22_HOST "mkdir -p /home/an/openclaw-speech"

# Create docker-compose.yml (no external image pull needed for whisper)
cat << 'EOF' | ssh $UB22_HOST "cat > /home/an/openclaw-speech/docker-compose.yml"
name: openclaw-speech

services:
  # Whisper.cpp ASR server - uses local build
  whisper-asr:
    image: docker.xuanyuan365.com/ghcr.io/ggerganov/whisper.cpp:server
    platform: linux/amd64
    restart: unless-stopped
    ports:
      - "10801:8080"
    volumes:
      - /home/an/whisper.cpp/models:/models
    command: >
      --model /models/for-tests-ggml-base.en.bin
      --host 0.0.0.0
      --port 8080
      --language auto
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

  # Fish Speech TTS - uses existing installation
  fish-speech:
    image: docker.xuanyuan365.com/docker.io/pytorch/pytorch:2.5.0-cuda12.4-cudnn9-runtime
    restart: unless-stopped
    ports:
      - "10802:8080"
    volumes:
      - /home/an/fish-speech:/app
    environment:
      - COMPILE=0
      - PYTHONPATH=/app
    working_dir: /app
    command: >
      sh -c "pip install -e . -q &&
      python -m tools.api_server
      --listen 0.0.0.0
      --port 8080
      --llama-checkpoint-path checkpoints/openaudio-s1-mini
      --decoder-checkpoint-path checkpoints/openaudio-s1-mini/codec.pth
      --decoder-config-name modded_dac_vq"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 120s
EOF

# Check if models exist
echo "=== Checking model files ==="
ssh $UB22_HOST "ls -la /home/an/whisper.cpp/models/for-tests-*.bin 2>&1 || echo 'No test models found'"
ssh $UB22_HOST "ls -la /home/an/fish-speech/checkpoints/ 2>&1 || echo 'Fish speech checkpoints not found'"

# Try to pull images (will fail without proper 轩辕 domain config)
echo "=== Attempting to pull Docker images ==="
ssh $UB22_HOST "cd /home/an/openclaw-speech && docker compose pull whisper-asr 2>&1 || true"

echo ""
echo "=== Next Steps ==="
echo "1. Configure your 轩辕专属域名 for Docker proxy access"
echo "2. Run: ./scripts/deploy-speech-services.sh <your-xuanyuan-domain>"
echo ""
echo "Or manually start services on ub22:"
echo "  ssh ub22 'cd /home/an/openclaw-speech && docker compose up -d'"
