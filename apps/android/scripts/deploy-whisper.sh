#!/bin/bash
# Deploy Whisper ASR service on ub22
# Usage: ./deploy-whisper-only.sh

set -e

UB22_HOST="192.168.0.107"

echo "=== Deploying Whisper ASR Service ==="

# Create deployment directory
ssh $UB22_HOST "mkdir -p /home/an/openclaw-speech"

# Create docker-compose.yml for Whisper only
cat << 'EOF' | ssh $UB22_HOST "cat > /home/an/openclaw-speech/docker-compose.yml"
name: openclaw-speech

services:
  # Whisper.cpp ASR server - speech to text
  whisper-asr:
    image: ghcr.io/ggerganov/whisper.cpp:server
    platform: linux/amd64
    restart: unless-stopped
    ports:
      - "10801:8080"
    volumes:
      - /home/an/whisper.cpp/models:/models:ro
    command: >
      --model /models/ggml-large-v3-turbo-q5_0.bin
      --host 0.0.0.0
      --port 8080
      --language auto
      --vad
      --vad-model /models/silero_vad.onnx
      --vad-threshold 0.5
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
EOF

# Download VAD model if not exists
ssh $UB22_HOST "cd /home/an/whisper.cpp/models && [ -f silero_vad.onnx ] || bash download-vad-model.sh"

# Try to pull image (will need 轩辕 domain or other proxy)
echo "=== Pulling Docker image ==="
ssh $UB22_HOST "cd /home/an/openclaw-speech && docker compose pull whisper-asr 2>&1 || echo 'Image pull failed - configure 轩辕 domain or Docker proxy'"

# Start service
echo "=== Starting Whisper ASR service ==="
ssh $UB22_HOST "cd /home/an/openclaw-speech && docker compose up -d whisper-asr 2>&1 || echo 'Start failed - check GPU drivers and Docker config'"

# Show status
echo "=== Service Status ==="
ssh $UB22_HOST "cd /home/an/openclaw-speech && docker compose ps"

# Test endpoint
echo "=== Testing Whisper ASR endpoint ==="
ssh $UB22_HOST "curl -s http://localhost:10801/health || echo 'Service not ready yet, check logs: docker compose logs'"

echo ""
echo "=== Deployment Complete ==="
echo "Whisper ASR: http://ub22:10801"
echo ""
echo "Android Integration:"
echo "  RemoteSpeechConfig.create("
echo "    whisperHost = \"ub22\","
echo "    whisperPort = 10801,"
echo "    fishSpeechHost = \"ub22\","
echo "    fishSpeechPort = 10802, // Not deployed yet"
echo "  )"
