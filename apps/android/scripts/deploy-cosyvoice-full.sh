#!/bin/bash
# CosyVoice TTS 部署脚本 (完整版)

set -e

echo "=== Deploying CosyVoice TTS (Full Build) ==="

# Create startup script with full dependencies
cat > /tmp/start-cosyvoice-full.sh << 'STARTSCRIPT'
#!/bin/bash
set -e

echo "=== CosyVoice Full Build ==="

# Install system build tools
echo "Installing system build tools..."
apt-get update -y
apt-get install -y g++ build-essential cython3 2>/dev/null || true

echo "Step 1: Install fastapi and uvicorn..."
pip install fastapi==0.115.6 uvicorn==0.30.0 --quiet 2>&1

echo "Step 2: Install core dependencies (skip problematic ones)..."
pip install conformer==0.3.2 \
            omegaconf==2.3.0 \
            hydra-core==1.3.2 \
            rich==13.7.1 \
            soundfile==0.12.1 \
            librosa==0.10.2 \
            inflect==7.3.1 \
            gdown==5.1.0 \
            wget==3.2 --quiet 2>&1

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
            tensorboard==2.14.0 \
            x-transformers==2.11.24 \
            wetext==0.0.4 --quiet 2>&1

echo "Step 4: Install pyworld (pre-built wheel)..."
# Try to install pyworld from pre-built wheel
pip install pyworld==0.3.4 --only-binary :all: --quiet 2>&1 || \
pip install pyworld==0.3.2 --quiet 2>&1 || \
pip install pyworld --quiet 2>&1 || echo "pyworld install skipped"

echo "Step 5: Install ONNX runtime..."
pip install onnx==1.16.0 --quiet 2>&1 || echo "onnx install skipped"
pip install onnxruntime==1.18.0 --quiet 2>&1 || echo "onnxruntime install skipped"

echo "Step 6: Install additional cosyvoice deps..."
pip install grpcio==1.57.0 grpcio-tools==1.57.0 --quiet 2>&1 || true
pip install model==0.0.2 --quiet 2>&1 || true

echo "Step 7: Start CosyVoice FastAPI server..."
cd /opt/CosyVoice
export PYTHONPATH=/opt/CosyVoice:/opt/CosyVoice/third_party/Matcha-TTS

# Verify imports before starting
python3 << 'PYCHECK'
import sys
print("Python path:", sys.path)
print("Testing imports...")
try:
    import fastapi
    print("  fastapi: OK")
except ImportError as e:
    print(f"  fastapi: FAIL - {e}")

try:
    import hyperpyyaml
    print("  hyperpyyaml: OK")
except ImportError as e:
    print(f"  hyperpyyaml: FAIL - {e}")

try:
    from cosyvoice.cli.cosyvoice import AutoModel
    print("  cosyvoice: OK")
except ImportError as e:
    print(f"  cosyvoice: FAIL - {e}")
PYCHECK

# Start the server
echo "Starting uvicorn..."
exec python3 -m uvicorn runtime.python.fastapi.server:app --host 0.0.0.0 --port 50000
STARTSCRIPT

chmod +x /tmp/start-cosyvoice-full.sh

# Create docker-compose file
cat > /tmp/cosyvoice-compose-full.yml << 'COMPOSEFILE'
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
      - /tmp/start-cosyvoice-full.sh:/start-cosyvoice-full.sh
    environment:
      - PYTHONPATH=/opt/CosyVoice:/opt/CosyVoice/third_party/Matcha-TTS
      - PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
    working_dir: /opt/CosyVoice
    entrypoint: ["/start-cosyvoice-full.sh"]
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:50000/health"]
      interval: 120s
      timeout: 10s
      retries: 3
      start_period: 600s

volumes:
  cosyvoice-models:
COMPOSEFILE

# Stop old containers
echo "Stopping old containers..."
docker compose -f /tmp/cosyvoice-compose-full.yml down 2>/dev/null || true

# Start service
echo "Starting Docker container (this will take a while)..."
docker compose -f /tmp/cosyvoice-compose-full.yml up -d

echo "Waiting for initial setup (120 seconds)..."
sleep 120

# Check status
echo "=== Container Status ==="
docker compose -f /tmp/cosyvoice-compose-full.yml ps

echo "=== Last 80 lines of logs ==="
docker compose -f /tmp/cosyvoice-compose-full.yml logs --tail=80

echo ""
echo "=== Test Service ==="
curl -s http://localhost:10803/health 2>/dev/null || echo "Service not ready yet"

echo ""
echo "Deployment in progress!"
echo "Check logs: docker compose -f /tmp/cosyvoice-compose-full.yml logs -f cosyvoice"
