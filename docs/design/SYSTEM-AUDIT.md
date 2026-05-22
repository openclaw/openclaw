# ClaWorks 系统全面审计（对照 OpenClaw 架构）

**更新**：2026-05-20  
**范围**：`packages/claworks-runtime`、`extensions/claworks-robot`、运维脚本、`docs/design`  
**验证**：`pnpm claworks:runtime:test`、`pnpm test extensions/claworks-robot`、`pnpm claworks:http-smoke`

---

## 1. 架构定位（与 OpenClaw 的关系）

```mermaid
flowchart LR
  OC[OpenClaw Gateway\nsrc/gateway] --> PL[claworks-robot 插件\nplugin-sdk]
  PL --> RT[@claworks/runtime\n进程内]
  PL --> BR[OpenClaw runtime\nLLM / channel / memory-core]
  RT --> IF[REST / MCP / A2A / Connectors]
  BR --> KB[memory-core + LanceDB]
```

| 层                                      | 职责                                                   | OpenClaw 对齐                           |
| --------------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| **Fork 核心** `src/`                    | Gateway、CLI、`CLAWORKS_PRODUCT=1` 时 `~/.claworks`    | 标准 OpenClaw 启动链                    |
| **@claworks/runtime**                   | 三平面：Kernel / Data / Orch + 接口层                  | 独立包；插件仅经 SDK + 公开 barrel      |
| **claworks-robot**                      | 唯一仓内产品插件：`registerService`、HTTP、`cw_*` 工具 | `definePluginEntry`、无 `src/**` 深导入 |
| **claworks-packs**（外仓）              | 业务对象、Playbook、Ingress/RBAC 策略                  | Pack 热加载，非核心硬编码               |
| **openclaw-claworks-extension**（可选） | 官方 OpenClaw 远程 HTTP/MCP 桥                         | 与内置 robot 工具名对齐                 |

**原则（AGENTS.md）**：核心保持插件无关；产品策略在 `claworks-robot` + `product-config-repair`；遗留修复走 `claworks doctor --fix`。

---

## 2. 模块地图与完成度

| 模块                   | 路径                                  | 完成度  | 说明                                  |
| ---------------------- | ------------------------------------- | ------- | ------------------------------------- |
| EventKernel            | `kernel/event-kernel.ts`              | **92%** | 发布、匹配、调度、Dedup、Outbox       |
| Ingress                | `kernel/ingress.ts`                   | **90%** | IM/Webhook→intent_route；OT/REST→Bus  |
| ObjectStore + Ontology | `planes/data/object-store.ts`         | **88%** | SQLite 主路径；PG schema ✅           |
| PlaybookEngine         | `planes/orch/playbook-engine.ts`      | **92%** | HITL、LLM/subagent/skill/connector 步 |
| KB                     | `memory-kb.ts` + `knowledge-base*.ts` | **85%** | 向量经 memory-core；stub 开发用       |
| REST `/v1`             | `interfaces/rest/router.ts`           | **90%** | 本轮补齐写端点 RBAC                   |
| MCP                    | `interfaces/mcp/server.ts`            | **88%** | 本轮补齐认证 + 写工具 RBAC            |
| A2A                    | `interfaces/a2a/`                     | **88%** | peer 白名单 + delegate RBAC           |
| Connectors             | `connectors/*` + presets              | **55%** | 默认 simulate，非现场 OT              |
| Studio                 | `studio/index.html`                   | **35%** | 运维面板；非 React 编辑器             |
| 产品化                 | npm 品牌 / 扩展裁剪                   | **55%** | 14 扩展已删；根包名仍 openclaw        |

**可运行闭环（烟测）**：约 **85%** — `pnpm claworks:smoke`  
**生产硬化（默认安全 + 独立发布）**：约 **70%**

---

## 3. 业务闭环（使用方法）

### 3.1 启动与配置

```bash
pnpm claworks:init          # ~/.claworks/claworks.json + packs 链接
CLAWORKS_VECTOR_KB=1 pnpm claworks:repair   # 向量 KB + 插件白名单
pnpm claworks:start       # Gateway + claworks-robot
pnpm claworks:doctor:fix  # 配置修复
```

### 3.2 典型链路

| 场景                | 入口                                          | 结果                                 |
| ------------------- | --------------------------------------------- | ------------------------------------ |
| 报警→诊断→HITL→工单 | `alarm.created` / REST `/v1/events`           | Playbook `diagnose_on_alarm`         |
| IM 意图             | `POST /v1/bridge/im` / `cw_bridge_im_message` | `classify_im_to_business_event`      |
| Webhook             | `POST /v1/bridge/webhook`                     | `classify_webhook_to_business_event` |
| KB 入库检索         | `/v1/kb/*`、`cw_kb_*`                         | memory-core 或 stub                  |
| Pack 安装           | `cw_install_pack` / REST packs                | RBAC 同步                            |
| 远程 OpenClaw       | `openclaw-claworks-extension`                 | 同 REST/MCP 契约                     |

### 3.3 验证命令

```bash
pnpm claworks:runtime:test
pnpm test extensions/claworks-robot
pnpm claworks:http-smoke
pnpm claworks:kb-smoke      # 需网关已启动
pnpm claworks:gateway:e2e   # 全 Gateway 闭环
```

---

## 4. 安全与可靠性

### 4.1 已具备

| 机制      | 实现                                                       |
| --------- | ---------------------------------------------------------- |
| API Key   | `config.api.api_key`；Bearer；`CLAWORKS_REQUIRE_API_KEY=1` |
| RBAC      | ObjectStore `RbacPolicy` + 默认策略；`rest.write`          |
| Ingress   | 策略表 + `robot.md` constitution `trusted_sources`         |
| 审计      | `security-audit.ts`（缺 key、明文 A2A、IM 自动桥等）       |
| HITL 超时 | `hitl.timeout` sweep                                       |
| Dedup     | 防事件循环                                                 |

### 4.2 本轮修复

| 问题                                      | 修复                                                   |
| ----------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `POST /v1/playbooks/{id}/runs` 无 RBAC    | `requireWrite(playbook:{id})`                          |
| `POST /v1/bridge/im                       | webhook` 无 RBAC                                       | `playbook.trigger` → `classify_*` Playbook（与 channel_user 默认策略对齐） |
| Pack install/reload/update/delete 无 RBAC | `pack:*` 资源                                          |
| Connector invoke 无 RBAC                  | `connector:{id}`                                       |
| MCP 无认证/RBAC                           | 与 REST 同源 `resolveAuthContext` + 写工具 `checkRbac` |
| runtime 依赖 `src/infra/node-sqlite`      | 迁入 `planes/data/node-sqlite.ts`                      |

### 4.3 运维注意

- **无 API Key 时**：本地 `subjectType: system` 允许写操作（开发模式）；生产务必配置 `api.api_key` 或 `CLAWORKS_REQUIRE_API_KEY=1`。
- **Gateway `auth: plugin`**：HTTP 边界在 claworks-robot；纵深防御需 Gateway token + robot API key。
- **MCP 读工具**：`cw_kb_search`、`cw_health` 等仅需认证，不校验 `rest.write`（与 REST GET 对称）。

---

## 5. 剩余技术债（非阻塞）

| 项                                 | 文档                         |
| ---------------------------------- | ---------------------------- |
| Studio React 全编辑器              | `REPO-STRUCTURE.md`          |
| Drizzle 全量 ORM                   | `POSTGRES-MIGRATION-PATH.md` |
| npm 发布 `@claworks/runtime`       | `RUNTIME-PACKAGE.md`         |
| Extension 全量裁剪（121→子集）     | `EXTENSION-PRUNE.md`         |
| OT Connector 生产级（非 simulate） | `connectors/`                |
| 根 `package.json` 品牌名           | `FORK-MODIFICATION-PLAN.md`  |

---

## 6. 文档权威顺序

1. **实现状态**：`IMPLEMENTATION-STATUS.md`（以烟测为准）
2. **API 契约**：`API-SPEC.md`、`CW-TOOLS-MATRIX.md`
3. **产品运维**：`PRODUCT-PROFILE.md`、`VECTOR-KB.md`
4. **路线图**：`ROADMAP.md`（部分 □ 滞后，勿单独作为验收依据）

---

## 7. 结论

ClaWorks 已具备 **可烟测的工业事件驱动运行时**（Pack + Playbook + Ingress + 多接口），与 OpenClaw 插件集成模式正确。本轮审计**优先修复 REST/MCP RBAC 一致性与 runtime 包边界**；剩余差距集中在 Studio、ORM 全量、扩展裁剪与现场 Connector。
