# ClaWorks 三仓运维 Checklist

**用途**：日常启停、新机器初始化、交付前核对。  
**更新**：2026-05-24  
**相关**：[`DEPLOYMENT.md`](../DEPLOYMENT.md) · [`RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md) · [`design/ECOSYSTEM-LAYOUT.md`](design/ECOSYSTEM-LAYOUT.md)

---

## 1. Clone 顺序（三仓主线）

按依赖从底到顶 clone sibling 目录（建议 `~/Projects/`）：

```bash
mkdir -p ~/Projects && cd ~/Projects

# 1) 产品本体（单体 Gateway + runtime）
git clone <claworks-url> claworks

# 2) Pack 真源（YAML / TS Playbook）
git clone <claworks-packs-url> claworks-packs

# 3) 官方 OpenClaw 桥接插件（可选；给已有 OpenClaw 用户连远程 Gateway）
git clone <openclaw-claworks-extension-url> openclaw-claworks-extension
```

| 仓                            | 角色                                       | 必须 |
| ----------------------------- | ------------------------------------------ | :--: |
| `claworks`                    | 单体 Gateway（18800）、runtime、robot 插件 |  ✅  |
| `claworks-packs`              | Industry Pack 唯一真源                     |  ✅  |
| `openclaw-claworks-extension` | 装到**官方** OpenClaw 的 `cw_*` 桥         | 按需 |

> **已废弃**：ClawTwin（18800）+ ClawOps（18801）+ `openclaw-gateway` 三服务 Compose。仅作历史参考：[`legacy/docker-compose-clawtwin-clawops.yml`](legacy/docker-compose-clawtwin-clawops.yml)。

---

## 2. 关键环境变量

| 变量                                   | 典型值                      | 说明                                           |
| -------------------------------------- | --------------------------- | ---------------------------------------------- |
| `CLAWORKS_PRODUCT`                     | `1`                         | 产品 CLI / Gateway 模式                        |
| `CLAWORKS_STATE_DIR`                   | `~/.claworks`               | 状态目录                                       |
| `CLAWORKS_CONFIG`                      | `~/.claworks/claworks.json` | **产品配置**（非 `~/.openclaw/openclaw.json`） |
| `CLAWORKS_GATEWAY_PORT`                | **18800**                   | Gateway 监听端口                               |
| `CLAWORKS_PACKS_DIR`                   | `../claworks-packs`         | Pack 真源路径                                  |
| `OPENCLAW_GATEWAY_TOKEN`               | （生产必填）                | Gateway 鉴权                                   |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 至少一项                    | 模型调用                                       |

**勿在新部署使用**：`CLAWTWIN_*`、`CLAWOPS_*`、`CLAWORKS_REDIS_URL`。

`.env` 可放在 repo 根或 `~/.claworks/.env`；模板见 [`.env.example`](../.env.example)。

---

## 3. 首次初始化 + 启动

```bash
cd ~/Projects/claworks
pnpm install

# 绑定 sibling Pack 仓并生成 ~/.claworks/claworks.json
CLAWORKS_PACKS_DIR=../claworks-packs CLAWORKS_INIT_SECURE=1 pnpm claworks:init

# 开发模式启动 Gateway（18800）
CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:gateway
```

验证：

```bash
curl -s http://127.0.0.1:18800/v1/health
CLAWORKS_PRODUCT=1 node claworks.mjs doctor
```

生产 Docker：见 [`DEPLOYMENT.md`](../DEPLOYMENT.md) → `docker compose -f docker-compose.prod.yml up -d --build`。

---

## 4. OpenClaw 桥接（可选第四仓）

仅当操作员已有**官方 OpenClaw**（18789），需 IM 对话触发 ClaWorks 时：

```bash
cd ~/Projects/openclaw-claworks-extension
pnpm install
openclaw plugins install -l ../openclaw-claworks-extension/extensions/claworks
```

在 **`~/.openclaw/openclaw.json`**（OpenClaw 配置，非 ClaWorks 产品部署）启用 `plugins.entries.claworks`，`url` 指向 `http://127.0.0.1:18800`。详见 [`design/ECOSYSTEM-EXTENSION-GUIDE.md`](design/ECOSYSTEM-EXTENSION-GUIDE.md) §六。

---

## 5. ⚠️ 勿用 Maibot openclaw 作 upstream

本地 sibling `../openclaw/`（若存在）常为 **Maibot / 飞书定制 fork**（如 `local/mai-wip`），**不是** claworks 的 upstream。

| 正确                                                  | 错误                                           |
| ----------------------------------------------------- | ---------------------------------------------- |
| upstream = `https://github.com/openclaw/openclaw.git` | 把 Maibot openclaw merge 进 claworks           |
| 只读 diff 对照 Maibot 行为                            | 用 Maibot 定制 seam 当产品默认                 |
| ClaWorks 配置 = `~/.claworks/claworks.json`           | 把产品部署文档指向 `~/.openclaw/openclaw.json` |

详见 [`LOCAL-GIT.md`](LOCAL-GIT.md) 与 [`design/UPSTREAM-SYNC.md`](design/UPSTREAM-SYNC.md)。

---

## 6. 日常运维速查

| 操作         | 命令                                                   |
| ------------ | ------------------------------------------------------ |
| 健康检查     | `curl -s http://127.0.0.1:18800/v1/health`             |
| 诊断修复     | `CLAWORKS_PRODUCT=1 node claworks.mjs doctor --fix`    |
| Pack 热重载  | `POST /v1/packs/reload`（需 API key）                  |
| 生产签收清单 | [`RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md)         |
| 五仓本地备份 | [`LOCAL-GIT.md`](LOCAL-GIT.md) → `ecosystem-backup.sh` |
