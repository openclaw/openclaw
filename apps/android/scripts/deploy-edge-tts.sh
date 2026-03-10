#!/bin/bash
# Deploy Edge TTS service to ub22 server
# Usage: ./deploy-edge-tts.sh

set -e

UB22_HOST="ub22"
EDGE_TTS_DIR="/home/an/edge-tts"

echo "=== Deploying Edge TTS to ub22 ==="

# Create directory on ub22
echo "Creating remote directory..."
ssh $UB22_HOST "mkdir -p $EDGE_TTS_DIR"

# Copy files to ub22
echo "Copying files..."
scp Dockerfile server.py $UB22_HOST:$EDGE_TTS_DIR/

# Build and run on ub22
echo "Building Docker image..."
ssh $UB22_HOST << 'ENDSSH'
cd /home/an/edge-tts
docker build -t edge-tts:latest . 2>&1
ENDSSH

echo "Starting Edge TTS service..."
ssh $UB22_HOST << 'ENDSSH'
cd /home/an/edge-tts
docker stop edge-tts 2>/dev/null || true
docker rm edge-tts 2>/dev/null || true
docker run -d \
  --name edge-tts \
  --restart unless-stopped \
  -p 10802:10802 \
  edge-tts:latest
ENDSSH

# Wait for service to start
echo "Waiting for service to start..."
sleep 5

# Health check
echo "Checking health..."
ssh $UB22_HOST "curl -s http://localhost:10802/health"

echo ""
echo "=== Edge TTS deployed successfully! ==="
echo "Service URL: http://192.168.0.107:10802"
echo "Health check: http://192.168.0.107:10802/health"
