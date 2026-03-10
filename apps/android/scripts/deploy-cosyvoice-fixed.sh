#!/bin/bash
# CosyVoice TTS 部署脚本 (修复版)
# 解决 webrtcsockets 依赖问题

set -e

echo "=== 部署 CosyVoice TTS (修复依赖) ==="

# 1. 停止旧容器
echo "停止旧容器..."
docker compose -f docker-compose-cosyvoice-fixed.yml down 2>/dev/null || true

# 2. 创建启动脚本
cat > /tmp/cosyvoice-start.sh << 'STARTSCRIPT'
#!/bin/bash
set -e

echo "步骤 1: 安装基础依赖..."
pip install fastapi==0.115.6 uvicorn==0.30.0 --quiet

echo "步骤 2: 安装语音处理依赖..."
pip install conformer==0.3.2 \
            omegaconf==2.3.0 \
            hydra-core==1.3.2 \
            rich==13.7.1 \
            soundfile==0.12.1 \
            librosa==0.10.2 \
            inflect==7.3.1 \
            gdown==5.1.0 \
            wget==3.2 --quiet

echo "步骤 3: 安装 ML 依赖..."
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
            wetext==0.0.4 --quiet

echo "步骤 4: 安装 ONNX (跳过 webrtcsockets)..."
pip install onnx==1.16.0 --quiet || true
# 不安装 onnxruntime-gpu，使用 CPU 版本避免 CUDA 兼容性问题
pip install onnxruntime==1.18.0 --quiet || echo "onnxruntime 安装失败，继续..."

echo "步骤 5: 启动 CosyVoice 服务..."
cd /opt/CosyVoice
export PYTHONPATH=/opt/CosyVoice:/opt/CosyVoice/third_party/Matcha-TTS

# 使用简易启动脚本
python3 << 'PYEOF'
import os
import sys
sys.path.append('/opt/CosyVoice')
sys.path.append('/opt/CosyVoice/third_party/Matcha-TTS')

print("导入 CosyVoice 模块...")
from cosyvoice.cli.cosyvoice import AutoModel

print("初始化模型...")
# 使用默认模型
model_dir = '/opt/models'
if not os.path.exists(model_dir):
    os.makedirs(model_dir)
    print(f"创建模型目录：{model_dir}")

# 启动模型
cosyvoice = AutoModel(model_dir)
print("CosyVoice 初始化完成!")
PYEOF

echo "启动 FastAPI 服务..."
exec python3 -m uvicorn runtime.python.fastapi.server:app --host 0.0.0.0 --port 50000
STARTSCRIPT

chmod +x /tmp/cosyvoice-start.sh

# 3. 创建简化的 docker-compose
cat > docker-compose-cosyvoice-fixed.yml << 'COMPOSE'
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
      - ./cosyvoice-start.sh:/start.sh
    environment:
      - PYTHONPATH=/opt/CosyVoice:/opt/CosyVoice/third_party/Matcha-TTS
      - PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
    working_dir: /opt/CosyVoice
    entrypoint: ["/start.sh"]
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
COMPOSE

# 4. 复制启动脚本到当前目录
cp /tmp/cosyvoice-start.sh ./cosyvoice-start.sh

# 5. 启动服务
echo "启动 Docker 容器..."
docker compose -f docker-compose-cosyvoice-fixed.yml up -d

echo "等待服务启动 (约 60 秒)..."
sleep 60

# 6. 检查状态
echo "=== 容器状态 ==="
docker compose -f docker-compose-cosyvoice-fixed.yml ps

echo "=== 最后 30 行日志 ==="
docker compose -f docker-compose-cosyvoice-fixed.yml logs --tail=30

echo "=== 测试服务 ==="
curl -s http://localhost:10803/health 2>/dev/null || echo "服务尚未就绪，请稍后检查"

echo ""
echo "部署完成！使用以下命令查看状态:"
echo "  docker compose -f docker-compose-cosyvoice-fixed.yml ps"
echo "  docker compose -f docker-compose-cosyvoice-fixed.yml logs -f"
