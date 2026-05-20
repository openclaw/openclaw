# ClaWorks 实现状态（对照设计文档）

**更新**：2026-05-20（设计对齐审计 + M2/M3 收尾）  
**结论**：`docs/design/` 中 **Phase 0–7 核心业务闭环已实现**；`@claworks/runtime` **M2 物理迁入 + M3 本地 dist** 已完成；根 `src/kernel|planes|interfaces|claworks` shim **已删除**；`packs-cli` 已迁入包内。  
**发布策略**：当前仅 **本地开发 / 仓内验证**，不执行 npm 公开发布。  
**测试**：`pnpm claworks:smoke` 或 `pnpm claworks:runtime:test` — **56 文件 / 141 用例** + e2e/http/dist-smoke。

---

## 设计 ↔ 实现对照（摘要）

| 设计（`docs/design/`）                                        | 实现                                                                 | 对齐            |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | --------------- |
| EventIngress：IM/Webhook → intent_route，OT/REST/MCP → kernel | `ingress.ts` + `applyIngressPublish`                                 | ✅              |
| intent_route 不泛洪 EventBus                                  | `ingress-publish.ts` 直接 `playbookEngine.trigger`                   | ✅              |
| `classify_im_to_business_event`                               | `claworks-packs/base/.../classify_im_to_business_event.yaml`         | ✅              |
| `classify_webhook_to_business_event`                          | `claworks-packs/base/.../classify_webhook_to_business_event.yaml`    | ✅（本轮补齐）  |
| RBAC/Ingress 从 ObjectStore 热加载                            | `rbac-sync.ts` + `POST /v1/rbac/reload` + pack reload                | ✅              |
| ObjectStore 清空 Ingress 回退默认                             | `syncIngressFromObjectStore` 空列表 → `DEFAULT_INGRESS_POLICIES`     | ✅（本轮修复）  |
| MCP `cw_*` 工具（设计曾写 7 个）                              | **12** 个（见下表）                                                  | ✅ 超出设计枚举 |
| MCP 发布走 Ingress                                            | `cw_publish_event` → `applyIngressPublish(source:mcp)`               | ✅（本轮修复）  |
| A2A 入站 peer 校验 + `a2a_delegate` RBAC                      | `a2a-peer-auth.ts` + task-handler / step-executor                    | ✅              |
| 通知目标：robot.md Owner + ObjectStore                        | `RobotOwner` + `notify-targets.ts`（非文档旧名 RobotAdmin）          | ✅              |
| `@claworks/runtime` 独立包                                    | M2 全量迁入；M3 本地 `dist` + dist-smoke（`publishConfig` 备而不用） | ✅ 本地可用     |
| Studio React 全编辑器                                         | 静态 HTML `/studio`                                                  | ❌ 非阻塞       |
| `POST /v1/bridge/webhook`                                     | `webhook-bridge.ts` + REST（与 IM 桥对称）                           | ✅              |

---

## MCP 工具清单（12）

| 工具                          | 说明                          |
| ----------------------------- | ----------------------------- |
| `cw_publish_event`            | Ingress 统一发布              |
| `cw_trigger_playbook`         | 手动触发 Playbook             |
| `cw_reload_packs`             | 重载 Pack + RBAC/Ingress 同步 |
| `cw_kb_search`                | KB 检索                       |
| `cw_query_objects`            | ObjectStore 查询              |
| `cw_list_playbooks`           | 列出 Playbook                 |
| `cw_health`                   | doctor/健康                   |
| `cw_get_identity`             | 机器人身份                    |
| `cw_bridge_im_message`        | IM 意图桥                     |
| `cw_list_runs` / `cw_get_run` | Run 查询                      |
| `cw_submit_hitl`              | HITL 决策                     |

---

## 业务闭环（可 E2E 验证）

| 链路                                                              | 状态 |
| ----------------------------------------------------------------- | ---- |
| `alarm.created` → `diagnose_on_alarm` → HITL → `WorkOrder`        | ✅   |
| `workorder.created` → `dispatch_mes_on_workorder_created`         | ✅   |
| KB ingest / 检索                                                  | ✅   |
| MRO `mro_alarm_to_workorder`                                      | ✅   |
| `reload_packs` / Pack Nexus install                               | ✅   |
| OT Connector → EventKernel（simulate）                            | ✅   |
| REST `/v1/*` + MCP + A2A                                          | ✅   |
| RBAC deny → `rbac.denied`                                         | ✅   |
| Ingress IM → intent_route（不经 Bus 泛洪）                        | ✅   |
| DedupGuard 防循环                                                 | ✅   |
| Robot Identity + `GET /v1/identity`                               | ✅   |
| `POST /v1/bridge/im` + `cw_bridge_im_message`                     | ✅   |
| `POST /v1/bridge/webhook`                                         | ✅   |
| `message_received` 自动桥（`im_bridge.auto_on_message_received`） | ✅   |
| base pack：RbacPolicy / IngressPolicy / RobotOwner / RobotMemory  | ✅   |

---

## Phase 0–4

与上轮一致：Fork、三平面、完整机器人、A2A 网格、`@claworks/sdk`、`cw_*` 工具、产品白名单均已交付。

| Phase 4 项                          | 状态                                                        |
| ----------------------------------- | ----------------------------------------------------------- |
| `@claworks/runtime`                 | ✅ M2 完成；根 shim 已删；`registerClaworksPacksCli` 在包内 |
| Extension 物理删除（仅 allow 裁剪） | ❌ 非阻塞                                                   |
| Studio React 全功能编辑器           | ❌ 非阻塞                                                   |

---

## Phase 5 — 治理与可观测 ✅

| 项                                           | 状态 |
| -------------------------------------------- | ---- |
| RBAC Guard + `rbac.denied` Playbook          | ✅   |
| Ingress Router + ObjectStore `IngressPolicy` | ✅   |
| `POST /v1/rbac/reload`                       | ✅   |
| `policy-sync` / 启动时 sync                  | ✅   |
| Prometheus metrics / decision-log            | ✅   |
| `handle_rbac_denied`                         | ✅   |

---

## Phase 6 — Studio / MCP / KB ✅

| 项                                     | 状态 |
| -------------------------------------- | ---- |
| Studio 静态运维面板 `/studio`          | ✅   |
| MCP 12 工具 + stdio 服务               | ✅   |
| KB + memory-core 桥（可选）            | ✅   |
| Pack 热重载 + ontology/playbook reload | ✅   |

---

## Phase 7 — 接入硬化 ✅

| 项                                                                           | 状态 |
| ---------------------------------------------------------------------------- | ---- |
| `applyIngressPublish` 统一 REST / IM / Connector / MCP                       | ✅   |
| A2A 入站 `peer_id` + `a2a.peers` 策略                                        | ✅   |
| `a2a_delegate` 前 `a2a.delegate` RBAC                                        | ✅   |
| `RobotOwner` + `notify-targets` + 插件 `notify-channel`                      | ✅   |
| `im-channel-hook` + `claworks-robot` 自动桥                                  | ✅   |
| `channel_user`：`playbook.trigger`（classify\__）+ `event.publish`（`im._`） | ✅   |

---

## `@claworks/runtime` 包结构（当前）

```
packages/claworks-runtime/
  src/kernel/*          ← 物理迁入
  src/pack-loader/*     ← 物理迁入
  src/claworks/*        ← 全部 runtime 模块（含 createClaworksRuntime）
  src/planes/data/*     ← ObjectStore、Ontology、KB、db
  src/planes/orch/*     ← PlaybookEngine、step-executor、HITL
  src/interfaces/*      ← REST、MCP、A2A、Connectors、Nexus
extensions/claworks-robot/   ← OpenClaw 薄插件（唯一仓内胶水）
```

**技术债（非阻塞）**：外仓 npm 发布/远程 git push、Studio React、Drizzle 全量 PG 路径。

---

## 设计文档尚未落地（对照 `docs/design/` + `ROADMAP.md`）

| 项                                                    | 设计出处                             | 状态                                                                                          |
| ----------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| Studio React 全功能编辑器                             | `REPO-STRUCTURE.md`、Phase 6         | ❌ 仅 `studio/index.html`                                                                     |
| 独立仓 `openclaw-claworks-extension`                  | `ROADMAP` M0.3、`STANDALONE-RUN.md`  | ✅ 本地 `/Users/power/Projects/openclaw-claworks-extension`（`@claworks/openclaw-extension`） |
| Extension 从 Fork **物理删除**（仅 allow 裁剪）       | `ROADMAP` Phase 4                    | ❌ 仍 bundled                                                                                 |
| Drizzle ORM + 9 迁移全量 PostgreSQL 生产路径          | `MIGRATION-GUIDE.md`、`ROADMAP`      | ⚠️ SQLite 闭环；`db-pg` 部分                                                                  |
| KB **向量检索**（Phase 2）                            | `REPO-STRUCTURE.md`、`CONFIG-SCHEMA` | ❌ 子串/文件 KB                                                                               |
| `contrib/industrial-oilgas-skills/` ClawTwin 愿景文档 | 并行产品叙事                         | ❌ 非 `docs/design/` 交付范围                                                                 |
| npm 公开发布 `@claworks/runtime`                      | `RUNTIME-PACKAGE` M3                 | ⏸ 按产品策略暂缓                                                                              |

**说明**：`ROADMAP.md` 中大量 `□` 未勾选为文档滞后，不代表对应 API/Playbook 未实现；以本文与 `pnpm claworks:smoke` 为准。

---

## 验证

```bash
pnpm claworks:smoke
# 或分项：
pnpm claworks:runtime:test
pnpm claworks:e2e
pnpm claworks:http-smoke
# Gateway 闭环：
pnpm claworks:init && pnpm claworks:gateway
node --import tsx scripts/claworks-closed-loop-demo.mjs
```

---

## 已知边界（非阻塞）

1. **npm 公开发布**：`publishConfig` 已备；当前策略为仓内 `dist` 验证 only。
2. **Drizzle 全量 ORM**：SQLite 同步 API 已满足当前闭环。
3. **Studio React 全编辑器**：运维静态页已够用。

---

## 企业通用业务扩展（enterprise-general Pack）

**状态**：✅ Pack 已实现，可通过 `packs.installed: ["base","enterprise-general"]` 启用。  
**路径**：`../claworks-packs/enterprise-general/`

| 模块       | 对象类型          | Playbook 数                       | 状态 |
| ---------- | ----------------- | --------------------------------- | ---- |
| 任务管理   | `Task`            | 3（创建通知/超期提醒/IM查询）     | ✅   |
| 审批流程   | `ApprovalRequest` | 2（发起/决策）                    | ✅   |
| 会议纪要   | `Meeting`         | 1（AI摘要+任务提取+KB入库）       | ✅   |
| 故障响应   | `Incident`        | 2（响应/复盘通知）                | ✅   |
| 运营自动化 | `DailyReport`     | 1（每日17:30 Cron AI日报）        | ✅   |
| 排班交接   | `ShiftSchedule`   | 1（换班提醒+HITL+RobotOwner更新） | ✅   |
| 公告广播   | `Announcement`    | 1（多频道广播+KB存档）            | ✅   |
| KB查询     | —                 | 1（IM KB问答）                    | ✅   |
| IM意图扩展 | —                 | classify_im 新增8类企业意图       | ✅   |

设计规划文档：`docs/design/BUSINESS-GENERAL-PLAN.md`

---

## 商务能力扩展（enterprise-commercial Pack）

**状态**：✅ Pack 已实现，可通过 `packs.installed: ["base","enterprise-general","enterprise-commercial"]` 启用。  
**路径**：`../claworks-packs/enterprise-commercial/`

| 模块           | 对象类型                     | Playbook 数                                       | 状态 |
| -------------- | ---------------------------- | ------------------------------------------------- | ---- |
| 知识库批量入库 | —                            | 1（文件夹→KB，含REST端点 `/v1/kb/ingest/folder`） | ✅   |
| 报价单生成     | `Customer` `Product` `Quote` | 2（AI生成+创建通知）                              | ✅   |
| 投标文件生成   | `BidProject` `BidDocument`   | 2（全套投标包/按类型）                            | ✅   |
| IM意图扩展     | —                            | classify_im 新增3类商务意图                       | ✅   |

新增 REST 端点：

- `POST /v1/kb/ingest/folder` — 批量文件夹入库（txt/md/json/csv/yaml）

新增 action types（`step-executor.ts` 已实现）：

- `ingest_folder` — Playbook 内批量入库文件夹
- `ingest_kb_text` — 单条文本入库
- `create_quote` — 创建报价单（自动生成编号，发布 `quote.created`）
- `create_bid_project` — 创建投标项目（发布 `bid_project.created`）
- `create_bid_document` — 保存AI生成的投标文件
- `create_customer` — 创建客户档案
- `create_product` — 创建产品/服务目录项

## 三种对接接口完整性

| 方式                 | 状态          | 备注                                                                          |
| -------------------- | ------------- | ----------------------------------------------------------------------------- |
| HTTP REST（方式A）   | ✅ 完全就绪   | `/v1/events`, `/v1/bridge/im`, `/v1/kb/*`, `/v1/objects/*`, `/v1/playbooks/*` |
| MCP工具集成（方式B） | ✅ 代码完整   | `openclaw-claworks-extension` 20个 `cw_*` 工具，需安装到官方OpenClaw          |
| A2A协议（方式C）     | ✅ 服务端就绪 | `/a2a/tasks/send` + `.well-known/agent.json`；`a2a_delegate` Playbook 步骤    |

---

## 相关文档

- `ARCHITECTURE.md` — 分层与 Ingress/RBAC 原则
- `API-SPEC.md` — REST 契约
- `RUNTIME-PACKAGE.md` — `@claworks/runtime` 迁入阶段与验证命令
- `ROADMAP.md` — 里程碑
- `EXTERNAL-EXTENSION.md` — 官方 OpenClaw 桥接外仓
- `REPO-STRUCTURE.md` — 目录与包边界
- `BUSINESS-GENERAL-PLAN.md` — 通用企业业务扩展规划（enterprise-general Pack）
