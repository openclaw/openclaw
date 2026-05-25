# ClaWorks 多实例部署指南

**用途**：在一台或多台机器上运行多个 ClaWorks Gateway，实现部门/域隔离与 A2A 跨域协作。  
**更新**：2026-05-25  
**相关**：[运维 Checklist](OPERATOR-CHECKLIST.md) · [生产部署](../DEPLOYMENT.md) · [A2A 双机示例](../contrib/examples/a2a-peer-mesh.zh.md)

---

## 产品模型（2026-05 起）

ClaWorks 采用 **单体 Gateway** 产品形态：一个 Node 进程承载 ObjectStore、Playbook、KB、MCP/A2A/REST 与 IM 通道。

| 项       | ClaWorks 产品（当前）                            | 已废弃（勿在新部署使用）                                                                   |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 进程模型 | 每实例一个 Gateway（`:18800` 起递增）            | ClawTwin `:18800` + ClawOps `:18801` + OpenClaw `:3000` 三服务栈                           |
| 配置文件 | `~/.claworks/claworks.json`（`CLAWORKS_CONFIG`） | `CLAWTWIN_*` / `CLAWOPS_*` / `CLAWORKS_REDIS_URL`                                          |
| 历史参考 | —                                                | [`legacy/docker-compose-clawtwin-clawops.yml`](legacy/docker-compose-clawtwin-clawops.yml) |

> **注意**：产品部署文档与示例均指向 **`claworks.json`**。仅在已有**官方 OpenClaw**（`:18789`）并通过 sibling 插件桥接远程 Gateway 时，才在 **`~/.openclaw/openclaw.json`** 中配置 `plugins.entries.claworks`。

---

## 架构选型

| 模式                  | 适用场景                       | 隔离方式                                                                 | 推荐度       |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------ | ------------ |
| **多 monolith**       | 多部门/多工厂/多域，彼此独立   | 独立进程 + 独立 `CLAWORKS_STATE_DIR` + 独立 DB                           | **首选**     |
| **twin + ops（1:1）** | 单域内需拆分数据面与编排面扩缩 | 两个 Gateway 共用同一 `database_url`，`robot.role` 分别为 `twin` / `ops` | 可选         |
| **A2A mesh**          | 跨域任务委派（告警 → 维修等）  | 各实例 `a2a.peers` 白名单 + Playbook `a2a_delegate`                      | 与上两种组合 |

**推荐路径**：先以 **多个 monolith** 落地（运维简单、故障域清晰）；仅在单域出现数据面/编排面资源争用时，再对该域做 **twin/ops 1:1 拆分**。

OpenClaw 个人 Agent（`:18789`）**不是** ClaWorks 内核替代品，而是可选的 **MCP/A2A 客户端节点**，通过 `cw_*` 工具或 A2A 接入已运行的 Gateway。

---

## 模式 A：多 monolith（推荐）

### 拓扑示例

```
制造部 Gateway (:18800)  ──A2A peers──►  供应链 Gateway (:18801)
  ~/.claworks-mfg/claworks.json            ~/.claworks-supply/claworks.json
  DB: claworks_mfg                         DB: claworks_supply
```

### 1. 准备状态目录与配置

**制造部（`:18800`）** — 合并 [`contrib/examples/multi-instance-monolith-mfg.claworks.fragment.json`](../contrib/examples/multi-instance-monolith-mfg.claworks.fragment.json)：

```bash
export CLAWORKS_STATE_DIR=~/.claworks-mfg
export CLAWORKS_CONFIG=~/.claworks-mfg/claworks.json
export CLAWORKS_GATEWAY_PORT=18800
CLAWORKS_PACKS_DIR=../claworks-packs CLAWORKS_INIT_SECURE=1 pnpm claworks:init
```

**供应链（`:18801`）** — 合并 [`contrib/examples/multi-instance-monolith-supply.claworks.fragment.json`](../contrib/examples/multi-instance-monolith-supply.claworks.fragment.json)：

```bash
export CLAWORKS_STATE_DIR=~/.claworks-supply
export CLAWORKS_CONFIG=~/.claworks-supply/claworks.json
export CLAWORKS_GATEWAY_PORT=18801
CLAWORKS_PACKS_DIR=../claworks-packs CLAWORKS_INIT_SECURE=1 pnpm claworks:init
```

各实例使用 **独立 PostgreSQL database**（或独立 SQLite 文件），不在同一 schema 内做逻辑租户隔离。

### 2. 启动

```bash
# 终端 A
CLAWORKS_STATE_DIR=~/.claworks-mfg CLAWORKS_CONFIG=~/.claworks-mfg/claworks.json \
  CLAWORKS_GATEWAY_PORT=18800 CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:gateway

# 终端 B
CLAWORKS_STATE_DIR=~/.claworks-supply CLAWORKS_CONFIG=~/.claworks-supply/claworks.json \
  CLAWORKS_GATEWAY_PORT=18801 CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:gateway
```

### 3. 验证

```bash
curl -sS http://127.0.0.1:18800/v1/health
curl -sS http://127.0.0.1:18801/v1/health
curl -sS http://127.0.0.1:18800/.well-known/agent.json
curl -sS http://127.0.0.1:18801/.well-known/agent.json
```

---

## 模式 B：twin + ops 拆分（可选，1:1）

适用于 **同一业务域** 内将数据面（ObjectStore/KB/Connector）与编排面（Playbook/HITL/Scheduler）分到两个 Gateway，**共用同一 `database_url`**。

| 平面   | `robot.role` | 典型端口 | 职责                                |
| ------ | ------------ | -------- | ----------------------------------- |
| 数据面 | `twin`       | `18800`  | 对象存储、KB、OT 连接器 ingest      |
| 编排面 | `ops`        | `18801`  | Playbook 执行、HITL、定时任务、通知 |

配置片段：[`contrib/examples/multi-instance-twin-ops.claworks.fragment.json`](../contrib/examples/multi-instance-twin-ops.claworks.fragment.json)（含 twin / ops 两份 `claworks.json` 结构）。

启动顺序：**先 twin，后 ops**（ops 依赖同一 DB 中的对象与 Playbook 注册表）。

> 这与已废弃的 **ClawTwin/ClawOps 独立 Python 服务** 不同：当前 twin/ops 均为 **同一 ClaWorks Gateway 镜像**，仅 `robot.role` 与启用的平面不同。

---

## A2A 跨实例协作

ClaWorks 实现 [Google A2A](https://google.github.io/A2A/) 协议子集，用于机器人间任务委派。

| 机制          | 说明                                                                           |
| ------------- | ------------------------------------------------------------------------------ |
| Agent Card    | `GET /.well-known/agent.json` — 对外暴露名称、能力与 endpoint                  |
| 入站任务      | `POST /a2a/tasks/send` — 需 peer 白名单 + Bearer 鉴权                          |
| Playbook 委派 | 步骤 `kind: a2a_delegate`，参数 `peer`、`task`                                 |
| 配置          | `plugins.entries.claworks-robot.config.a2a.peers[]`                            |
| RBAC          | 主体 `peer` 需具备 `a2a.delegate` 权限                                         |
| 宪法          | `robot.md` 中 `trusted_sources` 含 `peer`；`hitl_required` 可含 `a2a_delegate` |

**双机 walkthrough**（告警机器人 → 维修机器人）：[`contrib/examples/a2a-peer-mesh.zh.md`](../contrib/examples/a2a-peer-mesh.zh.md) + [`a2a-peer-mesh.openclaw.fragment.json`](../contrib/examples/a2a-peer-mesh.openclaw.fragment.json)。

生产建议：设置 `security.require_https_a2a: true`，peer URL 使用 HTTPS 内网域名。

---

## 可选：OpenClaw 桥接多实例

若操作员已有 **官方 OpenClaw**（非 Maibot fork），可通过 sibling 仓 **`openclaw-claworks-extension`** 在单个 OpenClaw Gateway 上管理多个远程 ClaWorks 实例：

合并 [`contrib/examples/multi-instance.openclaw.bridge.fragment.json`](../contrib/examples/multi-instance.openclaw.bridge.fragment.json) 到 **`~/.openclaw/openclaw.json`**：

```json
{
  "plugins": {
    "allow": ["claworks"],
    "entries": {
      "claworks": {
        "enabled": true,
        "config": {
          "instances": {
            "mfg": {
              "url": "http://127.0.0.1:18800",
              "label": "制造部 monolith"
            },
            "supply": {
              "url": "http://127.0.0.1:18801",
              "label": "供应链 monolith"
            }
          },
          "default": "mfg"
        }
      }
    }
  }
}
```

Agent 工具 `cw_*` 可通过 `instance=<名称>` 切换上下文。详见 [`design/ECOSYSTEM-EXTENSION-GUIDE.md`](design/ECOSYSTEM-EXTENSION-GUIDE.md) §六。

---

## 配置片段索引

| 文件                                                                     | 用途                                    |
| ------------------------------------------------------------------------ | --------------------------------------- |
| `contrib/examples/multi-instance-monolith-mfg.claworks.fragment.json`    | 制造部 monolith + A2A peers             |
| `contrib/examples/multi-instance-monolith-supply.claworks.fragment.json` | 供应链 monolith                         |
| `contrib/examples/multi-instance-twin-ops.claworks.fragment.json`        | twin/ops 1:1 拆分（双 `claworks.json`） |
| `contrib/examples/multi-instance.openclaw.bridge.fragment.json`          | OpenClaw 侧多实例桥接                   |
| `contrib/examples/a2a-peer-mesh.openclaw.fragment.json`                  | A2A 双 Gateway 最小 peer 配置           |

文件名中的 `openclaw.fragment` 为历史命名；**ClaWorks 产品部署**时将片段合并进对应实例的 **`claworks.json`**（`plugins.entries.claworks-robot.config` 段）。

---

## 运维速查

| 操作                 | 命令 / 链接                                          |
| -------------------- | ---------------------------------------------------- |
| 三仓 clone 与 env    | [`OPERATOR-CHECKLIST.md`](OPERATOR-CHECKLIST.md)     |
| Docker / Fly.io 生产 | [`DEPLOYMENT.md`](../DEPLOYMENT.md)                  |
| 单实例 init + doctor | `CLAWORKS_PRODUCT=1 node claworks.mjs doctor --fix`  |
| Pack 热重载          | `POST /v1/packs/reload`（需 API key）                |
| 配置 schema          | [`design/CONFIG-SCHEMA.md`](design/CONFIG-SCHEMA.md) |

---

## 常见错误

| 现象                          | 原因                           | 处理                                 |
| ----------------------------- | ------------------------------ | ------------------------------------ |
| 第二实例端口冲突              | 未设置 `CLAWORKS_GATEWAY_PORT` | 每实例递增端口（18800、18801…）      |
| A2A 403 / peer rejected       | `a2a.peers` 未互配或 URL 错误  | 双向检查 peer 名称与 URL             |
| twin/ops 数据不一致           | 指向不同 `database_url`        | twin 与 ops **必须**共用同一 DB      |
| 误用 ClawTwin/ClawOps Compose | 沿用废弃三服务栈               | 改用本文 monolith 或多 monolith 模式 |
