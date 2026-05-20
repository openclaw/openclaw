# ClaWorks 独立运行指南

ClaWorks 与官方 OpenClaw **可以同时安装**，互不冲突。

## 隔离机制

| 资源       | OpenClaw（个人助理）        | ClaWorks（企业机器人）      |
| ---------- | --------------------------- | --------------------------- |
| 状态目录   | `~/.openclaw/`              | `~/.claworks/`              |
| 配置文件   | `openclaw.json`             | `claworks.json`             |
| 默认端口   | **18789**                   | **18800**                   |
| Gateway 锁 | `/tmp/openclaw-<uid>/`      | `/tmp/claworks-<uid>/`      |
| CLI 入口   | `openclaw` → `openclaw.mjs` | `claworks` → `claworks.mjs` |

你电脑上正在运行的 OpenClaw（18789）**不会**被 ClaWorks 占用或修改。

## 首次初始化

```bash
cd /path/to/claworks
pnpm claworks:init
# 或覆盖已有配置：CLAWORKS_INIT_FORCE=1 pnpm claworks:init
```

## 启动 Gateway（开发模式，无需完整 build）

```bash
cd /path/to/claworks
node --import tsx src/entry.ts gateway run --port 18800 --bind loopback
# 或通过 claworks.mjs（需先 pnpm build）：
# node claworks.mjs gateway run --port 18800 --bind loopback
```

`claworks.mjs` 会自动设置 `CLAWORKS_PRODUCT=1` 和 `~/.claworks` 路径。

## 验证 API

```bash
curl http://127.0.0.1:18800/v1/health

curl -X POST http://127.0.0.1:18800/v1/events \
  -H 'Content-Type: application/json' \
  -d '{"type":"alarm.created","payload":{"mro_alarm_to_wo":true,"alarm_id":"a1"}}'

curl http://127.0.0.1:18800/v1/playbooks

curl -X POST http://127.0.0.1:18800/v1/doctor

curl http://127.0.0.1:18800/v1/packs
```

快捷启动：

```bash
pnpm claworks:gateway
```

## 端到端 Smoke（无需 Gateway build）

在仓库根目录执行，会加载同级 `claworks-packs`，跑三条链路：

1. `ingest_text_to_kb` 手动触发 + KB 检索
2. `mro_alarm_to_workorder` 事件匹配
3. `diagnose_on_alarm` → 诊断 → 工单 → HITL 审批 → 完成

```bash
cd /path/to/claworks
pnpm claworks:e2e
# 或指定 pack 目录：
# CLAWORKS_PACKS_DIR=/path/to/claworks-packs pnpm claworks:e2e
```

Gateway 已启动时追加 HTTP 探针：

```bash
CLAWORKS_E2E_HTTP=1 pnpm claworks:e2e
```

## Pack 管理 CLI

```bash
pnpm claworks packs list
pnpm claworks packs search alarm
pnpm claworks packs install nexus://process-industry@1.0.0
pnpm claworks packs update nexus://process-industry@1.0.0
pnpm claworks packs reload
```

## Nexus 本地注册表

```bash
pnpm claworks:nexus   # http://127.0.0.1:8080
pnpm claworks packs search
pnpm claworks packs install nexus://base@1.0.0
```

## 与 OpenClaw 扩展仓库的关系

- **`claworks/`** — 独立产品（本仓库 fork），运行企业机器人 Gateway
- **`openclaw-claworks-extension/`** — 安装在**官方 OpenClaw** 上的桥接插件（`@claworks/openclaw-extension`，`cw_*` 工具），连接远程 ClaWorks HTTP API。本地仓：`../openclaw-claworks-extension`（与 claworks 同级目录）。

个人助理用官方 OpenClaw + extension；企业机器人用 ClaWorks 独立进程。
