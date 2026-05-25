# ClaWorks 生产部署指南

ClaWorks 采用 **单体 Gateway** 模型：一个进程承载 ObjectStore、Playbook、KB、MCP/A2A/REST 与 OpenClaw 渠道桥接。

**运维清单**：[`docs/OPERATOR-CHECKLIST.md`](docs/OPERATOR-CHECKLIST.md)（三仓 clone、env、启动命令）。  
**可观测性**：[`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md)（Prometheus、traceparent、OTEL collector）。  
**多实例 / A2A**：[`docs/MULTI-INSTANCE-DEPLOYMENT.md`](docs/MULTI-INSTANCE-DEPLOYMENT.md)（多 monolith、twin/ops 拆分、peer mesh）。

**Canonical 运行时**：

| 项           | 值                                                          |
| ------------ | ----------------------------------------------------------- |
| 运行环境     | **Node.js 22+**（与 OpenClaw 一致）                         |
| CLI 入口     | `claworks.mjs`（或容器内 `node claworks.mjs gateway run`）  |
| 状态目录     | `~/.claworks/`                                              |
| 配置文件     | **`~/.claworks/claworks.json`**（`CLAWORKS_CONFIG` 可覆盖） |
| Gateway 端口 | **18800**（与 OpenClaw 个人默认 18789 隔离）                |

> 旧版 ClawTwin（18800）+ ClawOps（18801）+ OpenClaw Gateway（3000）三服务栈已废弃，见 [`docs/legacy/docker-compose-clawtwin-clawops.yml`](docs/legacy/docker-compose-clawtwin-clawops.yml)。

---

## 零门槛初始化（运维向）

### 1. 一键初始化

```bash
pnpm install
claworks init --profile enterprise    # 通用企业 Pack 组合
# 或
claworks init --profile industrial    # 流程工业（process-industry）
claworks init --profile daily-report  # 飞书日报分析
```

`init` 会写入 `~/.claworks/claworks.json`、生成 API Key，并按 profile 预装 Pack。完成后运行：

```bash
claworks doctor --fix
claworks gateway run --bind 0.0.0.0 --port 18800
```

生产环境建议先设置 `CLAWORKS_INIT_SECURE=1` 再执行 `init`，避免弱默认密钥。

### 2. 飞书 IM 通道

入驻完成后，Pack **`im_channel_setup_wizard`** 会在 `system.onboarding_completed` 时自动引导配置飞书；也可手动触发：

```bash
# REST 通用事件（需 operator 写权限 / API Key）
curl -X POST http://127.0.0.1:18800/v1/events \
  -H "Authorization: Bearer $CLAWORKS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"system.onboarding_completed","payload":{"feishu_app_id":"cli_xxx","feishu_app_secret":"xxx"}}'
```

凭证参数说明（`connect.apply` 能力，Playbook 内或运维脚本调用）：

| 参数                | 说明                                              |
| ------------------- | ------------------------------------------------- |
| `services`          | 必填，如 `["feishu"]`                             |
| `feishu_app_id`     | 飞书应用 App ID（优先于环境变量 `FEISHU_APP_ID`） |
| `feishu_app_secret` | 飞书应用 App Secret（优先于 `FEISHU_APP_SECRET`） |

也可在终端使用 OpenClaw 向导：`openclaw onboard feishu`。

### 3. 私域弱模型 → 商业模型离线进化（三步）

适用于**内网弱模型机器人**采集数据、**联网环境商业大模型**生成进化包、再回灌验证的场景：

1. **导出私域数据**（内网 Gateway，无需外网）

   ```bash
   claworks evolution export --days 30 > evolution-data.json
   # 或 REST：GET /v1/evolution/export?days=30
   ```

2. **商业模型离线生成进化包**（在可访问强模型的机器上，用导出 JSON 生成 `evolution-pack.json`，具体 prompt 见 Pack `enterprise-learning` 文档）

3. **导入并热更新**（回到内网 Gateway）
   ```bash
   claworks evolution import evolution-pack.json
   # 或 REST：POST /v1/evolution/import
   ```

**模拟蒸馏（弱模型回归 + 导出摘要）**：运维可调用便捷端点触发端到端流水线：

```bash
curl -X POST http://127.0.0.1:18800/v1/evolution/simulate \
  -H "Authorization: Bearer $CLAWORKS_API_KEY"
```

等效于发布事件 `evolution.simulation_requested`，由 Playbook `evolution_simulation_pipeline` 执行弱模型意图回归并将摘要写入 KB `simulation_runs`。

---

## 快速概览

| 组件                       | 作用                                           | 默认端口  |
| -------------------------- | ---------------------------------------------- | --------- |
| **ClaWorks Gateway**       | 单体产品网关（runtime + robot 插件 + `/v1/*`） | **18800** |
| **ClaWorks Nexus**（可选） | Pack 注册表 HTTP 服务                          | 8080      |

---

## 一、环境变量

### Gateway 必须（至少一项模型密钥）

```env
# AI 提供商密钥（至少一个）
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Gateway 访问令牌（生产强烈建议）
OPENCLAW_GATEWAY_TOKEN=your-secret-token

# 时区
OPENCLAW_TZ=Asia/Shanghai
```

### ClaWorks 产品路径（Docker 已预设；裸机默认 ~/.claworks）

```env
CLAWORKS_PRODUCT=1
CLAWORKS_STATE_DIR=~/.claworks
CLAWORKS_CONFIG=~/.claworks/claworks.json
CLAWORKS_GATEWAY_PORT=18800
```

### 可选

```env
# Pack 注册表（Nexus 侧车或 gateway 内 packs.registry 指向）
CLAWORKS_NEXUS_PORT=8080
CLAWORKS_NEXUS_HOST=0.0.0.0
CLAWORKS_NEXUS_CATALOG=/opt/claworks-packs

# 向量 KB（memory-core；不配置时使用 SQLite FTS）
CLAWORKS_LANCEDB_DATA_DIR=/data/claworks/vectors
CLAWORKS_VECTOR_KB=1

# 数据库（SQLite 默认；生产推荐 PostgreSQL）
DATABASE_URL=file:/data/claworks/claworks.db
# DATABASE_URL=postgresql://user:pass@db:5432/claworks

# API Key（REST/MCP 写操作；见 claworks.json api.api_key）
# CLAWORKS_REQUIRE_API_KEY=1
```

**已废弃 env（勿在新部署中使用）**：`CLAWTWIN_*`、`CLAWOPS_*`、`CLAWORKS_REDIS_URL`（无运行时引用）。

---

## 二、Docker Compose 生产部署

生产栈：**[`docker-compose.prod.yml`](docker-compose.prod.yml)**（单体 gateway + 可选 Nexus + 健康检查）。

```bash
docker compose -f docker-compose.prod.yml config   # 校验语法
docker compose -f docker-compose.prod.yml up -d --build
```

等价内联参考（与 `docker-compose.prod.yml` 保持同步）：

```yaml
services:
  claworks-gateway:
    image: ${CLAWORKS_IMAGE:-claworks:local}
    build: .
    command: ["node", "claworks.mjs", "gateway", "run", "--bind", "0.0.0.0", "--port", "18800"]
    environment:
      CLAWORKS_PRODUCT: "1"
      CLAWORKS_STATE_DIR: /home/node/.claworks
      CLAWORKS_CONFIG: /home/node/.claworks/claworks.json
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN:-}
      DATABASE_URL: file:/data/claworks/claworks.db
      CLAWORKS_LANCEDB_DATA_DIR: /data/claworks/vectors
    volumes:
      - claworks-state:/home/node/.claworks
      - claworks-data:/data/claworks
      - claworks-packs:/opt/claworks-packs:ro
    ports:
      - "18800:18800"

  nexus:
    image: ${CLAWORKS_IMAGE:-claworks:local}
    command: ["node", "scripts/claworks-nexus.mjs"]
    environment:
      CLAWORKS_NEXUS_CATALOG: /opt/claworks-packs
    ports:
      - "8080:8080"

volumes:
  claworks-state:
  claworks-data:
  claworks-packs:
```

首次启动前建议在本机构建配置：

```bash
CLAWORKS_INIT_SECURE=1 pnpm claworks:init
# 将生成的 ~/.claworks/claworks.json 挂载或复制到容器 claworks-state 卷
```

---

## 三、卷挂载说明

| 卷               | 容器路径               | 说明                                                  |
| ---------------- | ---------------------- | ----------------------------------------------------- |
| `claworks-state` | `/home/node/.claworks` | `claworks.json`、凭证、LaunchAgent 等价状态           |
| `claworks-data`  | `/data/claworks`       | SQLite / LanceDB 向量索引                             |
| `claworks-packs` | `/opt/claworks-packs`  | Industry Pack 只读挂载（sibling 仓 `claworks-packs`） |

绑定宿主目录示例：

```yaml
volumes:
  claworks-packs:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /mnt/claworks-packs
```

---

## 四、构建镜像

```bash
docker build -t claworks:local .

docker build \
  --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel,diagnostics-prometheus" \
  -t claworks:local .

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/claworks/claworks:latest \
  --push .
```

---

## 五、Fly.io 部署

见 `fly.toml`：

```bash
fly apps create claworks-prod
fly volumes create claworks_data --size 10 --region sin
fly secrets set OPENCLAW_GATEWAY_TOKEN="your-token" ANTHROPIC_API_KEY="sk-ant-..."
fly deploy
```

PostgreSQL（推荐生产）：

```bash
fly postgres create --name claworks-db
fly postgres attach claworks-db
```

---

## 六、PostgreSQL 迁移

```env
DATABASE_URL=postgresql://claworks:password@postgres:5432/claworks
```

启动时 runtime 自动执行 schema 迁移；手动：

```bash
pnpm claworks:migrate
```

---

## 七、健康检查

```bash
curl http://localhost:18800/v1/health
curl -H "Authorization: Bearer $KEY" http://localhost:18800/v1/doctor
curl http://localhost:8080/api/packages?family=claworks-pack   # Nexus
```

Gateway 内工具（需安装 `claworks-robot` 插件）：

```
cw_status
cw_doctor_run fix=true
```

---

## 八、Pack 管理

```bash
# 挂载 Pack 目录后热重载
curl -X POST http://127.0.0.1:18800/v1/packs/reload \
  -H "Authorization: Bearer $KEY"

# 通过 Nexus 安装
curl -X POST http://127.0.0.1:18800/v1/nexus/install \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"enterprise-general","version":"1.0.0"}'
```

Pack 真源在 sibling 仓 **`claworks-packs`**，见 [`contrib/README.md`](contrib/README.md)。

---

## 九、安全建议

- 生产必须设置 `OPENCLAW_GATEWAY_TOKEN` 与 `claworks.json` 内 `api.api_key`（或 `CLAWORKS_REQUIRE_API_KEY=1`）
- 使用反向代理（Nginx / Caddy / Traefik）终止 TLS；不要直接暴露 18800 到公网
- 定期备份 `claworks-state` + `claworks-data` 卷

```bash
docker run --rm \
  -v claworks-data:/source:ro \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/claworks-$(date +%Y%m%d).tar.gz -C /source .
```

---

## 十、与 OpenClaw 官方实例共存

|      | OpenClaw 个人   | ClaWorks 产品   |
| ---- | --------------- | --------------- |
| 端口 | 18789           | **18800**       |
| 状态 | `~/.openclaw`   | `~/.claworks`   |
| 配置 | `openclaw.json` | `claworks.json` |

可选：在官方 OpenClaw 上安装 sibling 插件 **`openclaw-claworks-extension`**，通过 HTTP/MCP 连接远程 ClaWorks Gateway（见 [`docs/design/EXTERNAL-EXTENSION.md`](docs/design/EXTERNAL-EXTENSION.md)）。
