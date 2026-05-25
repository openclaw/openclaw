# ClaWorks 快速上手

> 企业机器人运行时 — 事件驱动 · Playbook 驱动 · A2A 互联  
> 5 步从零到运行，10 分钟完成首次部署。

---

## 前置条件

| 工具    | 最低版本              | 说明                 |
| ------- | --------------------- | -------------------- |
| Node.js | **22.19+**（推荐 24） | `node -v` 验证       |
| pnpm    | **9+**                | `npm i -g pnpm` 安装 |
| Git     | 任意                  | 克隆仓库用           |
| SQLite  | 内置（Node 附带）     | 无需单独安装         |

可选（有对应功能时需要）：

| 工具                              | 用途                   |
| --------------------------------- | ---------------------- |
| 飞书企业自建应用                  | IM 消息收发、HITL 审批 |
| OpenAI / Anthropic / Qwen API Key | LLM 决策步骤           |
| OPC-UA / MQTT Broker              | 工业连接器             |

---

## 第一步：克隆仓库

```bash
# ClaWorks runtime
git clone https://github.com/claworks/claworks.git
cd claworks

# Pack 仓库（可选，本地开发用）
cd ..
git clone https://github.com/claworks/claworks-packs.git
cd claworks
```

---

## 第二步：安装依赖

```bash
# 在 claworks/ 目录下
pnpm install
```

> 首次安装约 1-3 分钟，会自动下载所有 workspace 包。

---

## 第三步：初始化配置

**推荐首次路径（与 `pnpm claworks:setup` 一致）：**

```bash
pnpm claworks:setup
# 等价流水线：doctor --fix → init（若缺配置）→ repair → onboard
```

**或分步执行：**

```bash
pnpm claworks:init          # 写入 ~/.claworks/claworks.json 骨架
pnpm claworks:repair        # product-config-repair 对齐
pnpm claworks:doctor        # 双层 health
node claworks.mjs onboard --mode local   # 交互 onboard（setup 会自动跑）
```

> 安装与 OpenClaw 共存：[`docs/claworks/install.md`](docs/claworks/install.md)

执行后会生成 `~/.claworks/claworks.json`，输出类似：

```
ClaWorks config written: /Users/you/.claworks/claworks.json
State directory: /Users/you/.claworks
Gateway port: 18800
Packs path: /Users/you/Projects/claworks-packs
Pack symlinks: base, process-industry, enterprise-general, enterprise-commercial
```

### 配置模型 API（必须，LLM 功能才可用）

编辑 `~/.claworks/claworks.json`，在 `plugins.entries` 节添加你的模型：

**使用 OpenAI（推荐）：**

```json
{
  "plugins": {
    "entries": {
      "openai": {
        "enabled": true,
        "config": {
          "OPENAI_API_KEY": "sk-your-key-here"
        }
      }
    }
  }
}
```

**使用 Anthropic：**

```json
{
  "plugins": {
    "entries": {
      "anthropic": {
        "enabled": true,
        "config": {
          "ANTHROPIC_API_KEY": "sk-ant-your-key-here"
        }
      }
    }
  }
}
```

**使用本地 Qwen（Ollama）：**

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "qwen-local/qwen3" }
    }
  },
  "plugins": {
    "entries": {
      "openai": {
        "enabled": true,
        "config": {
          "OPENAI_API_KEY": "ollama",
          "OPENAI_BASE_URL": "http://127.0.0.1:11434/v1"
        }
      }
    }
  }
}
```

### 配置飞书（可选，有 IM 功能时需要）

在 `~/.claworks/claworks.json` 中添加：

```json
{
  "plugins": {
    "entries": {
      "feishu": {
        "enabled": true,
        "config": {
          "FEISHU_APP_ID": "cli_your_app_id",
          "FEISHU_APP_SECRET": "your_app_secret"
        }
      }
    }
  }
}
```

> 飞书应用配置参见：[飞书开放平台 → 企业自建应用](https://open.feishu.cn/app)  
> 需要的权限：`im:message`, `im:message.receive_v1`, `im:chat`

---

## 第四步：启动网关

**推荐（含 bootstrap / repair）：**

```bash
pnpm claworks:start
# 等价：CLAWORKS_PRODUCT=1 node claworks.mjs start → Gateway 18800
```

**开发热重载（修改 TS 立即生效）：**

```bash
pnpm claworks:gateway
```

**生产模式（编译后，启动更快）：**

```bash
pnpm build
node claworks.mjs gateway run --port 18800 --bind loopback
```

网关启动后默认监听 `http://127.0.0.1:18800`（不与 OpenClaw 默认端口 18789 冲突）。

---

## 第五步：验证运行成功

```bash
pnpm claworks:doctor    # CLI 双层健康（网关 + 产品面）
curl http://127.0.0.1:18800/v1/health
```

预期输出：

```json
{
  "status": "ok",
  "version": "2026.5.x",
  "packs": ["base", "enterprise-general"],
  "robot": { "name": "claworks-robot", "role": "monolith" }
}
```

---

## 连接 OpenClaw（通过桥接插件）

如果你已有 OpenClaw 并想通过 `cw_*` 工具操作 ClaWorks：

```bash
# 在 OpenClaw 中安装桥接插件
openclaw plugins install @claworks/openclaw-extension
```

然后在 OpenClaw 配置中添加：

```json
{
  "plugins": {
    "entries": {
      "claworks": {
        "enabled": true,
        "config": {
          "url": "http://127.0.0.1:18800",
          "apiKey": "optional-bearer-token"
        }
      }
    }
  }
}
```

可用工具一览：`cw_status`、`cw_kb_search`、`cw_kb_ingest`、`cw_playbook_trigger`、`cw_hitl_pending`、`cw_agent_chat` 等共 15 个工具，详见 [extensions/claworks/index.ts](extensions/claworks/index.ts)。

---

## 常用命令速查

| 命令                                        | 作用                                         |
| ------------------------------------------- | -------------------------------------------- |
| `pnpm claworks:setup`                       | 首次一条龙：doctor → init → repair → onboard |
| `pnpm claworks:init`                        | 生成/修复 `~/.claworks/claworks.json`        |
| `pnpm claworks:start`                       | 启动 Gateway（18800，含 bootstrap）          |
| `pnpm claworks:gateway`                     | 开发热重载网关                               |
| `pnpm claworks:doctor`                      | CLI 健康检查                                 |
| `pnpm claworks:doctor:fix`                  | 非交互修复（同 repair 真源）                 |
| `curl .../v1/health`                        | 验证网关健康状态                             |
| `curl -X POST .../v1/packs/reload`          | 热重载 Pack（无需重启）                      |
| `curl -X POST .../v1/doctor/run`            | 运行健康自检                                 |
| `pnpm claworks:smoke`                       | 跑完整冒烟测试                               |
| `pnpm claworks:gateway:e2e`                 | 真实 Gateway 闭环 E2E                        |
| `pnpm claworks:ot-dry-run`                  | OT 模拟连接器（mqtt/opcua，无实机）          |
| `CLAWORKS_INIT_REPAIR=1 pnpm claworks:init` | 修复配置但不覆盖数据                         |

---

## Pack 配置

Pack 定义机器人的行为能力。默认初始化激活：`base`、`process-industry`、`enterprise-general`、`enterprise-commercial`。

**修改激活的 Pack：**

编辑 `~/.claworks/claworks.json` 中 `claworks-robot.config.packs.installed`：

```json
{
  "plugins": {
    "entries": {
      "claworks-robot": {
        "config": {
          "packs": {
            "auto_load": true,
            "paths": ["~/.claworks/packs"],
            "installed": [
              "base@1.3.0",
              "enterprise-foundation@1.0.0",
              "enterprise-general@1.0.0",
              "daily-report@1.0.0"
            ]
          }
        }
      }
    }
  }
}
```

**可用 Pack（`claworks-packs/claworks.packs.json` 中定义）：**

| Pack                    | 层级 | 说明                            |
| ----------------------- | ---- | ------------------------------- |
| `base`                  | L0   | 系统基础，所有新体系 Pack 的根  |
| `enterprise-foundation` | L1   | Person/Team/Task 等通用企业对象 |
| `enterprise-general`    | L3   | 任务管理、审批、会议纪要、日报  |
| `enterprise-commercial` | L3   | 报价单、投标、知识库批量入库    |
| `domain-knowledge`      | L2   | KB 管理、CBR 案例库             |
| `daily-report`          | L4   | Excel 日报→飞书卡片分析         |
| `process-industry`      | L3   | 工业设备/报警/工单（ISA-18.2）  |

热重载 Pack（不停机）：

```bash
curl -X POST http://127.0.0.1:18800/v1/packs/reload
```

---

## 环境变量参考

| 变量                       | 默认值                     | 说明                                                |
| -------------------------- | -------------------------- | --------------------------------------------------- |
| `CLAWORKS_STATE_DIR`       | `~/.claworks`              | 状态目录（配置/数据/packs）                         |
| `CLAWORKS_CONFIG`          | `$STATE_DIR/claworks.json` | 配置文件路径                                        |
| `CLAWORKS_GATEWAY_PORT`    | `18800`                    | 网关监听端口                                        |
| `CLAWORKS_PACKS_DIR`       | `../claworks-packs`        | Pack YAML 源目录                                    |
| `CLAWORKS_PRODUCT_PROFILE` | `extended`                 | 插件集合 (`core`/`extended`/`personal_work`/`full`) |
| `CLAWORKS_INIT_PROFILE`    | `enterprise`               | Pack 预置 (`core`/`enterprise`)                     |
| `CLAWORKS_OPENCLAW_KB_ROOT`| —                          | OpenClaw `knowledge_base` 挂载路径（personal_work） |
| `CLAWORKS_KB_WATCH_DIRS`   | —                          | filesystem-kb 监视目录（通常 `…/content`）          |
| `CLAWORKS_ORIOSEARCH_URL`  | —                          | 自托管 OrioSearch（Tavily 兼容联网搜索）            |

OpenClaw 知识库 SMB 挂载与七类 Markdown 批量入库见 [`docs/claworks/oriosearch-kb-setup.md`](docs/claworks/oriosearch-kb-setup.md)。

---

## 故障排查

**网关启动失败 — 端口占用：**

```bash
lsof -i :18800
CLAWORKS_GATEWAY_PORT=18801 pnpm claworks:gateway
```

**Pack 加载失败：**

```bash
# 检查符号链接
ls ~/.claworks/packs/

# 重新链接
CLAWORKS_PACKS_DIR=/path/to/claworks-packs pnpm claworks:init
```

**配置损坏，需要修复：**

```bash
CLAWORKS_INIT_REPAIR=1 pnpm claworks:init
```

## OT 连接器实机验证（预生产）

签收前在现场或 Testbox 完成（与 `docs/RELEASE-CHECKLIST.md` P1 #2 对应）：

1. 设 `production_mode=true`，运行 `claworks doctor --fix`，确认无 `connectors_simulate` / `connectors_echo_demo` 错误。
2. 编辑 `plugins.entries.claworks-robot.config.connectors.*`：`simulate: false`，填写 mqtt / opcua / modbus 真实 endpoint 与凭证。
3. 重启 Gateway（`pnpm claworks:gateway` 或 macOS `ai.claworks.gateway` LaunchAgent）。
4. `curl -s http://127.0.0.1:18800/v1/connectors` — 连接器状态为 healthy。
5. 触发 OT 事件或等待 poll，确认 `process-industry` Playbook 匹配与工单创建。

**模板**：`contrib/examples/ot-production.claworks.fragment.json` · **Feishu E2E**：`contrib/examples/feishu-live-e2e.env.example`

**全量健康自检：**

```bash
curl -X POST http://127.0.0.1:18800/v1/doctor/run?fix=true
```

---

## 下一步

- 📖 [设计文档](docs/design/ARCHITECTURE.md) — 三平面架构（Twin / Ops / Nexus）
- 📦 [安装与共存](docs/claworks/install.md) — fork 安装、npm 准备、与 OpenClaw 并存
- 🧩 [Pack 开发指南](../claworks-packs/HOW-TO-CREATE-A-PACK.md) — 创建自定义 Pack
- 🔌 [桥接插件](../openclaw-claworks-extension/README.md) — 从 OpenClaw 连接 ClaWorks
- 📊 [日报系统](../daily-report-system/README.md) — Excel 日报→飞书卡片
- 🔧 [CONFIG-SCHEMA.md](docs/design/CONFIG-SCHEMA.md) — 完整配置字段说明
