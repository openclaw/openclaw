# OpenClaw Docker 部署指南

## 🚀 快速开始

### 1. 使用 Docker Compose（推荐）

```bash
# 克隆仓库
git clone https://github.com/alijiujiu123/openclaw.git
cd openclaw

# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件，添加你的 API keys
nano .env

# 启动服务
docker compose up -d

# 查看日志
docker compose logs -f openclaw

# 访问 Dashboard
# http://localhost:18789?token=YOUR_GATEWAY_TOKEN
```

### 2. 使用 Docker Run

```bash
# 拉取镜像
docker pull openclaw/openclaw:latest

# 创建环境变量文件
cat > openclaw.env << EOF
ZHIPU_API_KEY=your_api_key_here
GATEWAY_TOKEN=your_secure_token
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
EOF

# 运行容器
docker run -d \
  --name openclaw \
  -p 18789:18789 \
  --env-file openclaw.env \
  -v openclaw-data:/root/.openclaw \
  -v $(pwd)/workspace:/workspace \
  --restart unless-stopped \
  openclaw/openclaw:latest

# 查看日志
docker logs -f openclaw
```

## 📋 环境变量配置

### 必需配置

| 变量 | 说明 | 示例 |
|------|------|------|
| `ZHIPU_API_KEY` | 智谱 AI API Key | `your_key_here` |
| `OPENAI_API_KEY` | OpenAI API Key | `sk-...` |
| `GATEWAY_TOKEN` | Gateway 认证 Token | `auto` 或自定义字符串 |

### 可选配置

**Telegram Bot**:
```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
```

**其他模型提供商**:
```bash
ANTHROPIC_API_KEY=sk-ant-...
COHERE_API_KEY=...
```

## 🗂️ 数据持久化

Docker 镜像使用两个 volume：

1. **`/root/.openclaw`** - 配置和记忆
   - Gateway 配置
   - Agent 记忆
   - Skills 数据

2. **`/workspace`** - 工作空间
   - Agent 生成的文件
   - 用户上传的文档
   - 临时文件

## 🔧 常用命令

```bash
# 查看容器状态
docker ps

# 查看日志
docker logs openclaw

# 实时日志
docker logs -f openclaw

# 停止容器
docker stop openclaw

# 启动容器
docker start openclaw

# 重启容器
docker restart openclaw

# 进入容器
docker exec -it openclaw sh

# 查看容器资源使用
docker stats openclaw

# 删除容器（数据会保留在 volume）
docker rm openclaw

# 删除 volume（⚠️ 会删除所有数据）
docker volume rm openclaw-data
```

## 🏥 健康检查

容器内置健康检查：

```bash
# 查看健康状态
docker inspect --format='{{.State.Health.Status}}' openclaw

# 手动测试健康检查
curl http://localhost:18789/health
```

健康检查参数：
- **间隔**: 30 秒
- **超时**: 10 秒
- **启动等待**: 40 秒
- **重试次数**: 3 次

## 🔄 更新镜像

```bash
# 拉取最新镜像
docker pull openclaw/openclaw:latest

# 重新创建容器
docker compose down
docker compose up -d

# 或者使用 docker run
docker stop openclaw
docker rm openclaw
docker run -d ... # 同上
```

## 📊 多平台支持

镜像支持以下架构：

- **linux/amd64** - x86_64 (Intel, AMD)
- **linux/arm64** - ARM64 (Apple Silicon, Raspberry Pi 4)

自动拉取正确架构的镜像：
```bash
docker pull openclaw/openclaw:latest
```

## 🐛 故障排除

### 1. 容器无法启动

```bash
# 查看日志
docker logs openclaw

# 常见问题：
# - API Key 未配置
# - 端口被占用
# - Volume 权限问题
```

### 2. 无法访问 Dashboard

```bash
# 检查端口映射
docker ps | grep openclaw

# 检查防火墙
sudo ufw allow 18789/tcp

# 检查 Gateway Token
docker exec openclaw cat /root/.openclaw/gateway/config.json
```

### 3. Telegram Bot 不工作

```bash
# 进入容器
docker exec -it openclaw sh

# 手动测试
openclaw channel:probe --channel telegram

# 检查配置
cat /root/.openclaw/channels/telegram/config.json
```

### 4. 数据丢失

**⚠️ 删除容器不会删除数据，但删除 volume 会！**

```bash
# 备份 volume
docker run --rm \
  -v openclaw-data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/openclaw-backup.tar.gz /data

# 恢复 volume
docker run --rm \
  -v openclaw-data:/data \
  -v $(pwd):/backup \
  alpine tar xzf /backup/openclaw-backup.tar.gz -C /
```

## 🔒 安全建议

1. **使用强密码** - 生成随机的 GATEWAY_TOKEN
   ```bash
   openssl rand -hex 32
   ```

2. **不要提交 .env 文件** - 已添加到 .gitignore

3. **限制访问** - 使用反向代理 (Nginx) + HTTPS
   ```nginx
   location / {
       proxy_pass http://localhost:18789;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection 'upgrade';
       proxy_set_header Host $host;
       proxy_cache_bypass $http_upgrade;
   }
   ```

4. **定期更新镜像** - 获取安全补丁
   ```bash
   docker pull openclaw/openclaw:latest
   docker compose up -d
   ```

## 📚 相关资源

- [OpenClaw 文档](https://docs.openclaw.ai)
- [Docker Hub](https://hub.docker.com/r/openclaw/openclaw)
- [GitHub Issues](https://github.com/alijiujiu123/openclaw/issues)
- [Simon 的 Docker 指南](https://til.simonwillison.net/llms/openclaw-docker)

## 🤝 贡献

欢迎提交 PR 和 Issue！

---

**更新时间**: 2026-02-02
**维护者**: OpenClaw Community
