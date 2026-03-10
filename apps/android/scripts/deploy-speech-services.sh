#!/bin/bash
# Deploy Whisper.cpp + Fish Speech TTS services on ub22
# Usage: ./deploy-speech-services.sh [轩辕专属域名]

set -e

XUANYUAN_DOMAIN="${1:-}"
UB22_HOST="ub22"

if [ -z "$XUANYUAN_DOMAIN" ]; then
    echo "Usage: $0 <轩辕专属域名>"
    echo "Example: $0 3jkpkp4ngyen9a.xuanyuan.run"
    echo ""
    echo "获取专属域名：登录 https://xuanyuan365.com 然后点击左侧菜单栏的「专属域名」"
    exit 1
fi

echo "=== Deploying Whisper + Fish Speech with 轩辕域名：$XUANYUAN_DOMAIN ==="

# Create deployment directory on ub22
ssh $UB22_HOST "mkdir -p /home/an/openclaw-speech"

# Copy docker-compose.yml with replaced domain
sed "s/XXX.xuanyuan.run/$XUANYUAN_DOMAIN/g" docker-compose.yml > /tmp/docker-compose-ub22.yml
scp /tmp/docker-compose-ub22.yml $UB22_HOST:/home/an/openclaw-speech/docker-compose.yml

# Create model download script
cat << 'EOF' > /tmp/download-models.sh
#!/bin/bash
cd /home/an/whisper.cpp/models

# Download whisper model
if [ ! -f "ggml-large-v3-turbo-q5_0.bin" ]; then
    echo "Downloading Whisper large-v3-turbo-q5_0 model..."
    bash download-ggml-model.sh large-v3-turbo-q5_0
fi

# Download VAD model
if [ ! -f "silero_vad.onnx" ]; then
    echo "Downloading Silero VAD model..."
    bash download-vad-model.sh
fi

echo "Models downloaded successfully"
EOF

scp /tmp/download-models.sh $UB22_HOST:/home/an/openclaw-speech/download-models.sh
ssh $UB22_HOST "chmod +x /home/an/openclaw-speech/download-models.sh"

# Download models
echo "=== Downloading models ==="
ssh $UB22_HOST "bash /home/an/openclaw-speech/download-models.sh"

# Create symlink to fish-speech
echo "=== Setting up fish-speech ==="
ssh $UB22_HOST "ln -sf /home/an/fish-speech /home/an/openclaw-speech/fish-speech || true"

# Pull Docker images
echo "=== Pulling Docker images ==="
ssh $UB22_HOST "cd /home/an/openclaw-speech && docker compose pull"

# Start services
echo "=== Starting services ==="
ssh $UB22_HOST "cd /home/an/openclaw-speech && docker compose up -d"

# Show status
echo "=== Service Status ==="
ssh $UB22_HOST "cd /home/an/openclaw-speech && docker compose ps"

echo ""
echo "=== Deployment Complete ==="
echo "Whisper ASR: http://ub22:10801"
echo "Fish Speech TTS: http://ub22:10802"
echo ""
echo "View logs: ssh ub22 'cd /home/an/openclaw-speech && docker compose logs -f'"
