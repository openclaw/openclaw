# ClaWorks 生产部署指南

ClaWorks 基于 OpenClaw 构建，使用相同的 Docker 镜像流程，并扩展了工业/企业专属服务（ClawTwin、ClawOps、ClaWorks Nexus）。

---

## 快速概览

| 组件               | 作用                           | 默认端口 |
| ------------------ | ------------------------------ | -------- |
| OpenClaw Gateway   | AI 消息网关（继承自 OpenClaw） | 3000     |
| ClawTwin（数据面） | ObjectStore、知识库、MCP 接口  | 18800    |
| ClawOps（编排面）  | Playbook 引擎、HITL 审批       | 18801    |
| ClaWorks Nexus     | Pack 注册表 HTTP 服务          | 8080     |

---

## 一、环境变量

### OpenClaw Gateway 必须

```env
# AI 提供商密钥（至少一个）
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Gateway 访问令牌（强烈建议生产环境设置）
OPENCLAW_GATEWAY_TOKEN=your-secret-token

# 时区
OPENCLAW_TZ=Asia/Shanghai
```

### ClaWorks Runtime 专属

```env
# ClawTwin 数据面
CLAWTWIN_BASE_URL=http://127.0.0.1:18800
CLAWTWIN_AUTH_TOKEN=your-twin-token          # 可选，生产建议启用

# ClawOps 编排面
CLAWOPS_BASE_URL=http://127.0.0.1:18801
CLAWOPS_AUTH_TOKEN=your-ops-token            # 可选

# ClaWorks Nexus Pack 注册表
CLAWORKS_NEXUS_PORT=8080
CLAWORKS_NEXUS_HOST=0.0.0.0
CLAWORKS_NEXUS_CATALOG=/opt/claworks-packs   # 挂载路径

# Redis 会话缓存（可选，不配置时使用内存存储）
CLAWORKS_REDIS_URL=redis://redis:6379

# LanceDB 向量存储（可选，不配置时使用 SQLite FTS）
CLAWORKS_LANCEDB_DATA_DIR=/data/claworks/vectors

# ClaWorks 核心数据库
DATABASE_URL=file:/data/claworks/claworks.db     # SQLite（默认）
# DATABASE_URL=postgresql://user:pass@db:5432/claworks  # PostgreSQL
```

---

## 二、Docker Compose 完整部署

下面是包含 Redis 和 ClaWorks 全栈的 `docker-compose.prod.yml`：

```yaml
services:
  openclaw-gateway:
    image: ${CLAWORKS_IMAGE:-claworks:local}
    build: .
    restart: unless-stopped
    env_file:
      - path: .env
        required: false
    environment:
      HOME: /home/node
      OPENCLAW_HOME: /home/node
      OPENCLAW_STATE_DIR: /home/node/.openclaw
      OPENCLAW_CONFIG_PATH: /home/node/.openclaw/openclaw.json
      OPENCLAW_CONFIG_DIR: /home/node/.openclaw
      OPENCLAW_WORKSPACE_DIR: /home/node/.openclaw/workspace
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN:-}
      OPENCLAW_TZ: ${OPENCLAW_TZ:-Asia/Shanghai}
      # 指向内部 ClaWorks 服务
      CLAWTWIN_BASE_URL: http://clawtwin:18800
      CLAWOPS_BASE_URL: http://clawops:18801
      CLAWORKS_REDIS_URL: redis://redis:6379
    volumes:
      - openclaw-state:/home/node/.openclaw
      - openclaw-workspace:/home/node/.openclaw/workspace
    depends_on:
      - redis
      - clawtwin
      - clawops
    ports:
      - "3000:3000"
    cap_drop:
      - NET_RAW
      - NET_ADMIN
    security_opt:
      - no-new-privileges:true

  clawtwin:
    image: ${CLAWTWIN_IMAGE:-clawtwin:local}
    restart: unless-stopped
    environment:
      DATABASE_URL: file:/data/claworks/claworks.db
      CLAWTWIN_AUTH_DEV: ${CLAWTWIN_AUTH_DEV:-0}
      CLAWORKS_LANCEDB_DATA_DIR: /data/claworks/vectors
    volumes:
      - claworks-data:/data/claworks
      - claworks-packs:/opt/claworks-packs:ro
    ports:
      - "18800:18800"

  clawops:
    image: ${CLAWOPS_IMAGE:-clawops:local}
    restart: unless-stopped
    environment:
      CLAWTWIN_BASE_URL: http://clawtwin:18800
      DATABASE_URL: file:/data/claworks/claworks.db
    volumes:
      - claworks-data:/data/claworks
      - claworks-packs:/opt/claworks-packs:ro
    ports:
      - "18801:18801"
    depends_on:
      - clawtwin

  nexus:
    image: ${CLAWORKS_IMAGE:-claworks:local}
    restart: unless-stopped
    command: node scripts/claworks-nexus.mjs
    environment:
      CLAWORKS_NEXUS_PORT: 8080
      CLAWORKS_NEXUS_HOST: 0.0.0.0
      CLAWORKS_NEXUS_CATALOG: /opt/claworks-packs
    volumes:
      - claworks-packs:/opt/claworks-packs:ro
    ports:
      - "8080:8080"

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru

volumes:
  openclaw-state:
  openclaw-workspace:
  claworks-data:
  claworks-packs:
  redis-data:
```

---

## 三、卷挂载说明

| 卷                   | 宿主路径示例            | 说明                            |
| -------------------- | ----------------------- | ------------------------------- |
| `openclaw-state`     | `~/.openclaw`           | OpenClaw 配置、会话、凭证       |
| `openclaw-workspace` | `~/.openclaw/workspace` | Agent 工作区文件                |
| `claworks-data`      | `/opt/claworks/data`    | SQLite 数据库、LanceDB 向量索引 |
| `claworks-packs`     | `/opt/claworks-packs`   | Industry Pack 只读挂载          |
| `redis-data`         | 容器内 `/data`          | Redis AOF 持久化                |

挂载宿主路径时：

```bash
# 修改 Compose 中对应 volume 定义
volumes:
  claworks-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /mnt/disk/claworks-data
```

---

## 四、构建镜像

```bash
# 标准构建
docker build -t claworks:local .

# 包含可选扩展（如 diagnostics-otel）
docker build \
  --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel,diagnostics-prometheus" \
  -t claworks:local .

# 多平台构建（Buildx）
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/claworks/claworks:latest \
  --push .
```

---

## 五、Fly.io 部署

见 `fly.toml`，关键配置：

```bash
fly apps create claworks-prod
fly volumes create claworks_data --size 10 --region sin
fly secrets set OPENCLAW_GATEWAY_TOKEN="your-token" ANTHROPIC_API_KEY="sk-ant-..."
fly deploy
```

PostgreSQL（推荐生产环境）：

```bash
fly postgres create --name claworks-db
fly postgres attach claworks-db
# 将注入 DATABASE_URL 环境变量
```

---

## 六、PostgreSQL 迁移

ClaWorks 支持 SQLite（开发）和 PostgreSQL（生产）。

```env
# .env 中设置
DATABASE_URL=postgresql://claworks:password@postgres:5432/claworks
```

初次启动时 ClaWorks Runtime 会自动执行 schema 迁移（`db-migrate.ts`）。

若需手动执行：

```bash
pnpm claworks:migrate
```

---

## 七、健康检查

```bash
# OpenClaw Gateway
curl http://localhost:3000/api/v1/health

# ClawTwin
curl http://localhost:18800/v1/health

# ClawOps
curl http://localhost:18801/v1/health

# Nexus
curl http://localhost:8080/api/packages?family=claworks-pack
```

通过 OpenClaw 的 `cw_status` 工具（需安装 claworks 插件）：

```
cw_status                          # 默认实例
cw_status instance=mfg-twin        # 指定实例
cw_doctor_run fix=true             # 自动修复诊断
```

---

## 八、Pack 管理

```bash
# 挂载 Pack 目录并重载（无需重启）
cw_reload_packs

# 通过 Nexus 安装（需 ClawTwin 已连接 Nexus）
curl -X POST http://localhost:18800/v1/nexus/install \
  -H "Content-Type: application/json" \
  -d '{"id":"enterprise-general","version":"1.0.0"}'
```

---

## 九、安全建议

- 生产环境必须设置 `OPENCLAW_GATEWAY_TOKEN` 和 `CLAWTWIN_AUTH_TOKEN`
- Redis 不暴露到公网；仅容器网络内部访问
- 使用反向代理（Nginx / Caddy / Traefik）终止 TLS，不要直接暴露 3000 端口
- 定期备份 `claworks-data` 卷（SQLite DB + LanceDB 向量索引）

```bash
# 备份示例
docker run --rm \
  -v claworks-data:/source:ro \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/claworks-$(date +%Y%m%d).tar.gz -C /source .
```
