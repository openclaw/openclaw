# ClaWorks 生态扩展开发手册

**更新**：2026-05-23  
**阶段**：核心产品 Phase 0–7 已完成 → **本手册面向生态扩展**  
**读者**：Pack 作者、系统集成商、垂直 ISV、OpenClaw 用户、运维

---

## 零、五分钟判断：我属于哪类角色？

| 角色                | 你要做什么                    | 主要仓库                      | 必读章节                     |
| ------------------- | ----------------------------- | ----------------------------- | ---------------------------- |
| **业务用户 / 运维** | 启停 Gateway、装 Pack、配飞书 | `claworks`                    | §一、§二                     |
| **Pack 作者**       | 行业 Playbook、ObjectType     | `claworks-packs`              | §三                          |
| **连接器开发者**    | OPC-UA/MQTT/REST 接入         | `claworks/connectors`         | §四                          |
| **垂直 ISV**        | 独立引擎 + Pack 集成          | 新仓 + `claworks-packs`       | §五                          |
| **OpenClaw 用户**   | 不 Fork，连企业 ClaWorks      | `openclaw-claworks-extension` | §六                          |
| **核心贡献者**      | Runtime/API                   | `claworks` packages           | `CORE-ARCHITECTURE-GUIDE.md` |

---

## 一、用户使用指南

### 1.1 五仓布局

```
~/Projects/
├── claworks/                      # 产品 Gateway + runtime
├── claworks-packs/                # Pack 唯一真源
├── openclaw-claworks-extension/   # 官方 OpenClaw 桥接
├── daily-report-system/           # 垂直应用示例
└── openclaw/                      # 上游（可选，Maibot 定制）
```

### 1.2 首次部署（10 分钟）

```bash
cd ~/Projects/claworks
pnpm install
CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:init
pnpm claworks:gateway
```

验证：

```bash
curl -s http://127.0.0.1:18800/v1/health
open http://127.0.0.1:18800/studio   # 静态运维面板
```

详细步骤：`../../QUICKSTART.md`（仓根）

### 1.3 常用运维

| 操作              | 命令                                                    |
| ----------------- | ------------------------------------------------------- |
| 诊断              | `pnpm claworks:doctor` 或 `curl .../v1/doctor/run`      |
| 重载 Pack         | `POST /v1/packs/reload` 或 Agent 工具 `cw_reload_packs` |
| 手动触发 Playbook | `POST /v1/playbooks/{id}/trigger`                       |
| 查看运行          | `GET /v1/playbooks/runs`                                |
| 生产模式 init     | `CLAWORKS_INIT_SECURE=1 pnpm claworks:init`             |

### 1.4 选择 Pack Profile

编辑 `claworks-packs/claworks.packs.json` 或使用 init 时装配：

| Profile 意图 | 建议 pack                                               |
| ------------ | ------------------------------------------------------- |
| 工业 MRO     | `base` + `process-industry`                             |
| 通用企业     | `base` + `enterprise-foundation` + `enterprise-general` |
| 商务扩展     | + `enterprise-commercial`                               |
| 团队日报     | + `daily-report`（配 Python 引擎）                      |
| 个人 KB 同步 | `base` + `personal-enterprise`                          |

> **注意**：旧体系 `core/comms/knowledge/workflow` 与新体系 `base/enterprise-foundation/...` **勿同时启用**（Playbook ID 会冲突）。新建机器人只用 **base 链**。  
> 完整说明见 [`claworks-packs/PACK-LAYER-SYSTEMS.md`](../../../claworks-packs/PACK-LAYER-SYSTEMS.md)。

---

## 二、业务逻辑（用户视角）

用户无需读代码，只需理解 **事件 → Playbook → 对象/通知**：

1. ** something happens** — 设备报警、IM 消息、定时 Cron、REST 推送
2. **ClaWorks 匹配 Playbook** — 按 `trigger` 规则
3. **自动执行步骤** — 查 KB、调 LLM、写工单、发飞书
4. **需要人时** — HITL 卡片，批准后继续
5. **下游联动** — 新对象触发新 Playbook（如工单 → MES）

示例剧本见 `claworks-packs/base/`、`process-industry/`、`enterprise-general/`。

---

## 三、Pack 扩展（生态主路径）

### 3.1 真源与边界

- **唯一真源**：`claworks-packs/<pack-id>/`
- **不要**在 `claworks/contrib/packs/` 或 `claworks/packs/` 写 YAML 源码
- **示例模板**：`claworks/contrib/examples/starter-{pack,declarative,imperative}/`

### 3.2 声明式 Pack（推荐，5 分钟）

**场景**：每日晨报 — 定时汇总数据发飞书

```yaml
# claworks-packs/acme-ops/ontology/playbooks/daily_ops_report.yaml
id: acme-ops.daily_ops_report
name: 每日运维简报
pack: acme-ops
version: "1.0"

trigger:
  kind: schedule
  cron: "0 9 * * 1-5"
  timezone: Asia/Shanghai

steps:
  - id: report
    kind: call_playbook
    params:
      playbook_id: process.collect_and_report
      inputs:
        title: "运维日报"
        data_source: "{{ robot.config.report_webhook }}"
        notify_channel: feishu
```

```json
// claworks-packs/acme-ops/claworks.pack.json
{
  "id": "acme-ops",
  "name": "Acme 运维 Pack",
  "version": "1.0.0",
  "provides": { "playbooks": ["acme-ops.daily_ops_report"] }
}
```

本地验证：

```bash
CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:init
pnpm claworks:gateway
curl -X POST http://127.0.0.1:18800/v1/playbooks/acme-ops.daily_ops_report/trigger \
  -H "Authorization: Bearer $CLAWORKS_API_KEY"
```

### 3.3 命令式 Pack（自定义 action）

参考 `claworks-packs/industrial/src/index.ts` — 注册 `registerCapabilities` 供 Playbook `kind: action` 调用。

### 3.4 通用框架 Playbook（base 自带）

业务 Pack 优先 **委派** 而非重写：

| 框架 ID                       | 用途     |
| ----------------------------- | -------- |
| `process.collect_and_report`  | 定时报告 |
| `process.detect_and_escalate` | 告警升级 |
| `process.request_and_approve` | 审批     |
| `process.search_and_reply`    | KB 问答  |

完整列表：`claworks-packs/PACK_DEVELOPMENT.md`

### 3.5 发布给租户

1. Pack 目录进入 `claworks-packs`（git 或 Nexus，见 `NEXUS.md`）
2. 租户 `packs.installed` 或 `claworks pack install`
3. `POST /v1/packs/reload`

---

## 四、Connector 扩展（OT / IT 系统）

### 4.1 模型

Connector = **stdio NDJSON 子进程**，由 `ConnectorManager` 管理（`packages/claworks-runtime/src/interfaces/connectors/`）。

内置：`connectors/echo`、`mqtt`、`opcua`、`modbus`、`rest-poll`、`filesystem-kb`

### 4.2 配置示例

```json
// ~/.claworks/claworks.json → plugins.entries.claworks-robot.config.connectors
{
  "plant-mqtt": {
    "preset": "mqtt",
    "env": { "CLAWORKS_MQTT_BROKER": "mqtt://broker:1883", "CLAWORKS_MQTT_TOPIC": "plant/alarms/#" }
  }
}
```

### 4.3 Playbook 调用

```yaml
steps:
  - id: invoke_scada
    kind: connector.invoke
    params:
      connector_id: plant-mqtt
      method: publish
      params: { topic: "cmd/ack", payload: { alarm_id: "{{ event.payload.alarm_id }}" } }
```

### 4.4 新 Connector 清单

1. 在 `connectors/my-bridge/` 实现 NDJSON 协议（参考 `echo/echo-bridge.mjs`）
2. 在 `presets.ts` 注册 preset
3. 文档写入 `connectors/README.md`
4. 集成测试：`packages/claworks-runtime/src/interfaces/connectors/presets.test.ts`

---

## 五、垂直应用扩展（ISV 模式）

**范例**：`daily-report-system`

| 层       | 职责                     | 位置                                      |
| -------- | ------------------------ | ----------------------------------------- |
| 领域引擎 | Python/Go/… 分析逻辑     | `daily-report-system/src/`                |
| Pack     | 触发、通知、HITL         | `claworks-packs/daily-report/`            |
| 安装脚本 | symlink pack + 租户 YAML | `daily-report-system/claworks/install.sh` |
| 发布包   | wheel + `.cws`           | `scripts/build-release.sh`                |

复制此模式时：

1. 新建 sibling 仓（引擎）
2. 在 `claworks-packs/` 增加 `<vertical>/` pack
3. 提供 `install.sh` 指向 pack，**不要**复制 playbook 到应用仓
4. 在工作区 `openclaw.code-workspace` 加入文件夹

---

## 六、OpenClaw 官方用户（远程桥）

不 Fork `claworks`，安装 extension：

```bash
cd ~/Projects/openclaw-claworks-extension
pnpm install
openclaw plugins install -l ../openclaw-claworks-extension/extensions/claworks
```

配置 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "entries": {
      "claworks": {
        "enabled": true,
        "config": {
          "url": "http://127.0.0.1:18800",
          "apiKey": "your-gateway-key"
        }
      }
    }
  }
}
```

Agent 可用 **22 个** `cw_*` 工具（查询对象、触发 Playbook、KB、HITL 等）。  
完整列表：`CW-TOOLS-MATRIX.md`

多实例（Twin/Ops 分离）见 extension `skills/claworks-multi/SKILL.md`。

---

## 七、REST 集成范例（MES / 低代码）

### 7.1 推送业务事件

```bash
curl -X POST http://127.0.0.1:18800/v1/events \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "alarm.created",
    "source": "mes",
    "payload": { "equipment_id": "P-101", "severity": "P1", "description": "振动超限" }
  }'
```

### 7.2 查询对象

```bash
curl "http://127.0.0.1:18800/v1/objects/WorkOrder?limit=5" -H "Authorization: Bearer $KEY"
```

### 7.3 IM Webhook 桥

```bash
curl -X POST http://127.0.0.1:18800/v1/bridge/im \
  -H "Authorization: Bearer $KEY" \
  -d '{ "text": "查一下 P-101 最近报警", "user_id": "u123" }'
```

契约：`API-SPEC.md`

---

## 八、A2A 多机器人 mesh

1. 每个机器人暴露 `GET /.well-known/agent.json`
2. 对端 `POST /a2a/tasks/send` 委派任务
3. Playbook 步骤 `a2a.send` / `a2a_delegate`
4. 配置 `a2a.peers` + RBAC `a2a.delegate`

---

## 九、生态扩展路线图（建议优先级）

| 优先级 | 扩展类型             | 产出                                                |
| ------ | -------------------- | --------------------------------------------------- |
| P1     | 行业 Pack            | `claworks-packs/<industry>/`                        |
| P1     | 租户 profile         | `claworks.packs.json` profiles                      |
| P2     | 新 Connector         | `connectors/<preset>/`                              |
| P2     | 垂直 SaaS            | sibling 仓 + pack                                   |
| P3     | Pack Nexus /registry | 见 `NEXUS.md`                                       |
| P3     | 向量 KB              | `VECTOR-KB.md` + memory-core / `CLAWORKS_VECTOR_KB` |
| 最后   | npm 品牌发布         | `REBRAND-TO-CLAWORKS.md`                            |

---

## 十、质量与验收

| 层级      | 命令                                                               |
| --------- | ------------------------------------------------------------------ |
| Pack 作者 | 手动 trigger + `pnpm claworks:smoke`（若改 runtime）               |
| Connector | preset 单测 + gateway e2e                                          |
| Extension | `pnpm test extensions/claworks/canonical-surface.contract.test.ts` |
| 垂直应用  | `pytest` + `scripts/build-release.sh`                              |

---

## 十一、本地 Git 与备份（不推 GitHub）

```bash
~/Projects/scripts/ecosystem-backup.sh
```

分支：`claworks` → `local/claworks-product`；详见 `docs/LOCAL-GIT.md`

---

## 相关文档

- [PRODUCT-COMPLETION.md](./PRODUCT-COMPLETION.md) — 核心是否完毕
- [CORE-ARCHITECTURE-GUIDE.md](./CORE-ARCHITECTURE-GUIDE.md) — 模块与事件链
- sibling `claworks-packs/PACK_DEVELOPMENT.md` — Pack 细节
- [API-SPEC.md](./API-SPEC.md) — REST
- [EXTERNAL-EXTENSION.md](./EXTERNAL-EXTENSION.md) — 外仓 extension
- [DIRECTORY-LAYOUT.md](./DIRECTORY-LAYOUT.md) — 目录真源
