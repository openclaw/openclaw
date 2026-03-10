# OpenClaw 语音服务部署指南

## 服务器信息

- **主机**: ub22
- **IP 地址**: 192.168.0.107
- **GPU**: NVIDIA (CUDA 支持)

## 服务端口

| 服务 | 端口 | 状态 |
|------|------|------|
| Whisper ASR | 10801 | 待部署 |
| Fish Speech TTS | 10802 | 待部署 |

---

## 快速部署 Whisper ASR

### 前提条件

1. ub22 服务器可访问 (`ssh 192.168.0.107`)
2. Docker 和 Docker Compose 已安装
3. NVIDIA GPU 驱动和 Container Toolkit 已配置

### 一键部署

```bash
cd /home/iouoi/openclaw/apps/android
./scripts/deploy-whisper.sh
```

### 手动部署

如果自动部署失败，可以手动执行：

```bash
# 1. SSH 到 ub22
ssh 192.168.0.107

# 2. 创建部署目录
mkdir -p /home/an/openclaw-speech

# 3. 创建 docker-compose.yml
cat > /home/an/openclaw-speech/docker-compose.yml << 'EOF'
name: openclaw-speech

services:
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
EOF

# 4. 拉取 Docker 镜像 (需要网络代理)
cd /home/an/openclaw-speech
docker compose pull whisper-asr

# 5. 启动服务
docker compose up -d whisper-asr

# 6. 查看日志
docker compose logs -f
```

---

## 验证部署

### 检查服务状态

```bash
ssh 192.168.0.107 "docker compose -f /home/an/openclaw-speech/docker-compose.yml ps"
```

### 测试 Whisper API

```bash
# 健康检查
curl http://192.168.0.107:10801/health

# 测试语音识别 (需要有 WAV 文件)
curl -X POST "http://192.168.0.107:10801/inference" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@test.wav" \
  -F "temperature=0.0"
```

---

## Android 集成

### 配置远程语音服务

在 Android 应用中配置：

```kotlin
// 使用默认配置 (192.168.0.107)
val config = RemoteSpeechConfig.default()

// 或自定义配置
val config = RemoteSpeechConfig.create(
    whisperHost = "192.168.0.107",
    whisperPort = 10801,
    fishSpeechHost = "192.168.0.107",
    fishSpeechPort = 10802,
)

val service = RemoteSpeechService(context, scope, config)
```

### 使用语音识别

```kotlin
// 检查连接
val connected = service.checkConnection()

// 转录音频
val text = service.transcribeAudio(audioData)
```

---

## 故障排除

### Docker 镜像拉取失败

**问题**: 无法从 ghcr.io 拉取镜像

**解决方案 1**: 使用轩辕专属域名
```bash
# 替换 xxx 为你的专属域名
sed -i 's|ghcr.io|xxx-ghcr.xuanyuan.run|g' docker-compose.yml
docker compose pull
```

**解决方案 2**: 手动拉取并导入
```bash
# 在可以访问 ghcr.io 的机器上
docker pull ghcr.io/ggerganov/whisper.cpp:server
docker save ghcr.io/ggerganov/whisper.cpp:server > whisper.tar

# 传输到 ub22
scp whisper.tar 192.168.0.107:/tmp/

# 导入并标记
docker load < /tmp/whisper.tar
docker tag whisper.cpp:server ghcr.io/ggerganov/whisper.cpp:server
```

### GPU 不可用

```bash
# 检查 NVIDIA 驱动
ssh 192.168.0.107 "nvidia-smi"

# 检查 Docker GPU 支持
ssh 192.168.0.107 "docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi"
```

### 服务无法访问

```bash
# 检查防火墙
ssh 192.168.0.107 "sudo ufw status"

# 开放端口 (如果需要)
ssh 192.168.0.107 "sudo ufw allow 10801/tcp"

# 检查服务监听
ssh 192.168.0.107 "ss -tlnp | grep 10801"
```

---

## 清理

```bash
# 停止服务
ssh 192.168.0.107 "docker compose -f /home/an/openclaw-speech/docker-compose.yml down"

# 删除所有数据
ssh 192.168.0.107 "rm -rf /home/an/openclaw-speech"
```

---

## 相关文件

- `apps/android/docker-compose.yml` - Docker 服务配置
- `apps/android/scripts/deploy-whisper.sh` - 部署脚本
- `apps/android/voice/RemoteSpeechService.kt` - Android 集成代码
- `apps/android/DEPLOY_STATUS.md` - 部署状态

## 参考链接

- [Whisper.cpp GitHub](https://github.com/ggerganov/whisper.cpp)
- [HF-Mirror](https://hf-mirror.com) - Hugging Face 镜像
- [轩辕专属域名](https://xuanyuan365.com) - Docker 镜像代理
