#!/bin/bash
# CosyVoice TTS 部署脚本 (修复版)

set -e

echo "=== Deploying CosyVoice TTS ==="

# Create startup script
cat > /tmp/start-cosyvoice.sh << 'STARTSCRIPT'
#!/bin/bash
set -e

echo "=== CosyVoice Startup ==="

echo "Step 1: Install fastapi and uvicorn..."
pip install fastapi==0.115.6 uvicorn==0.30.0 --quiet 2>&1 || true

echo "Step 2: Install speech dependencies..."
pip install conformer==0.3.2 \
            omegaconf==2.3.0 \
            hydra-core==1.3.2 \
            rich==13.7.1 \
            soundfile==0.12.1 \
            librosa==0.10.2 \
            inflect==7.3.1 \
            gdown==5.1.0 \
            wget==3.2 --quiet 2>&1 || true

echo "Step 3: Install ML dependencies..."
pip install diffusers==0.29.0 \
            transformers \
            HyperPyYAML==1.2.3 \
            matplotlib==3.7.5 \
            networkx==3.1 \
            numpy==1.26.4 \
            protobuf==4.25 \
            pyarrow==18.1.0 \
            pydantic==2.7.0 \
            pyworld==0.3.4 \
            tensorboard==2.14.0 \
            x-transformers==2.11.24 \
            wetext==0.0.4 --quiet 2>&1 || true

echo "Step 4: Install ONNX runtime..."
pip install onnx==1.16.0 --quiet 2>&1 || echo "onnx install skipped"
pip install onnxruntime==1.18.0 --quiet 2>&1 || echo "onnxruntime install skipped"

echo "Step 5: Start CosyVoice FastAPI server..."
cd /opt/CosyVoice
export PYTHONPATH=/opt/CosyVoice:/opt/CosyVoice/third_party/Matcha-TTS

# Start the server
exec python3 -m uvicorn runtime.python.fastapi.server:app --host 0.0.0.0 --port 50000
STARTSCRIPT

chmod +x /tmp/start-cosyvoice.sh

# Create docker-compose file
cat > /tmp/cosyvoice-compose.yml << 'COMPOSEFILE'
name: cosyvoice

services:
  cosyvoice:
    image: pytorch/pytorch:2.5.0-cuda12.4-cudnn9-runtime
    restart: unless-stopped
    ports:
      - "10803:50000"
    volumes:
      - /home/an/CosyVoice:/opt/CosyVoice
      - cosyvoice-models:/opt/models
      - /tmp/start-cosyvoice.sh:/start-cosyvoice.sh
    environment:
      - PYTHONPATH=/opt/CosyVoice:/opt/CosyVoice/third_party/Matcha-TTS
      - PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
    working_dir: /opt/CosyVoice
    entrypoint: ["/start-cosyvoice.sh"]
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:50000/health"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 300s

volumes:
  cosyvoice-models:
COMPOSEFILE

# Stop old containers
echo "Stopping old containers..."
docker compose -f /tmp/cosyvoice-compose.yml down 2>/dev/null || true

# Start service
echo "Starting Docker container..."
docker compose -f /tmp/cosyvoice-compose.yml up -d

echo "Waiting for service to start..."
sleep 30

# Check status
echo "=== Container Status ==="
docker compose -f /tmp/cosyvoice-compose.yml ps

echo "=== Last 50 lines of logs ==="
docker compose -f /tmp/cosyvoice-compose.yml logs --tail=50

echo ""
echo "=== Test Service ==="
curl -s http://localhost:10803/health 2>/dev/null || echo "Service not ready yet, check logs"

echo ""
echo "Deployment complete!"
echo "Check status: docker compose -f /tmp/cosyvoice-compose.yml ps"
echo "View logs: docker compose -f /tmp/cosyvoice-compose.yml logs -f cosyvoice"
