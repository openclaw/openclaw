# ClaWorks ↔ OpenClaw 全维度对齐审计

**更新**：2026-05-23  
**范围**：ClaWorks fork（`claworks`）相对 upstream OpenClaw 的使用体验、架构边界、Foundry+AIP 能力、基础业务闭环。

---

## 1. 架构边界（必须对齐）

| 维度                 | OpenClaw 标准                  | ClaWorks 实现                                    | 对齐度   | 说明                               |
| -------------------- | ------------------------------ | ------------------------------------------------ | -------- | ---------------------------------- |
| Core plugin-agnostic | `src/` 无产品硬编码            | ✅ 业务在 `@claworks/runtime` + `claworks-robot` | **95%**  | fork 仅 ~11 个 product 文件        |
| 插件 SDK 边界        | `definePluginEntry` + manifest | ✅ `extensions/claworks-robot`                   | **95%**  | 无 `src/**` 深 import              |
| 配置契约             | `plugins.entries.<id>.config`  | ✅ `openclaw.plugin.json#configSchema`           | **90%**  | 已补 production_mode/api/im_bridge |
| Doctor 修复          | `openclaw doctor --fix`        | ✅ + `claworks doctor` 健康项                    | **90%**  | legacy 走 product repair           |
| Gateway 端口         | 18789                          | ✅ 18800 隔离                                    | **100%** | `claworks-gateway.ts`              |
| 状态目录             | `~/.openclaw`                  | ✅ `~/.claworks` + `claworks.json`               | **100%** | `product-env.ts`                   |

---

## 2. OpenClaw 使用体验对齐（用户侧）

| 用户能力   | OpenClaw 用法             | ClaWorks 等价                                   | 对齐度  | Gap                             |
| ---------- | ------------------------- | ----------------------------------------------- | ------- | ------------------------------- |
| CLI 启动   | `openclaw gateway`        | `claworks gateway` / `pnpm claworks:gateway`    | **95%** | 根包名仍 openclaw               |
| 配置向导   | `openclaw configure`      | ✅ 继承 + claworks 默认                         | **90%** | 机器人 Pack 需 IM/文档引导      |
| IM 对话    | 渠道插件 → agent 自动回复 | ✅ 双路径：OpenClaw agent **或** IM→EventKernel | **85%** | auto-bridge 需 init/repair 开启 |
| Skills     | ClawHub + workspace       | ✅ 4 个 robot skills + OpenClaw skills          | **90%** | Builder 依赖 cw\_\* 工具        |
| Agent 工具 | 插件 registerTool         | ✅ 48× `cw_*`                                   | **95%** | 远程 extension 22 工具          |
| HITL/审批  | managedFlows + 渠道       | ✅ Playbook HITL + managedFlows 桥              | **85%** | 无 Studio 审批 UI               |
| Webhook    | webhooks 插件             | ✅ `/v1/bridge/webhook` + classify              | **90%** | Ingress 策略需配置              |
| 流式回复   | block/preview streaming   | ✅ 继承 Feishu 等渠道                           | **90%** | Playbook notify 非流式          |
| Doctor     | 健康检查 + fix            | ✅ + ClaWorks 专项 checks                       | **90%** | —                               |
| 插件安装   | `plugins install`         | ✅ 白名单 bundled + 外仓 extension              | **85%** | 磁盘未物理裁剪                  |

---

## 3. Runtime 桥接（OpenClaw ↔ ClaWorks）

| Bridge         | OpenClaw API                     | ClaWorks 消费点                      | 状态                         |
| -------------- | -------------------------------- | ------------------------------------ | ---------------------------- |
| LLM            | `api.runtime.llm.complete`       | Playbook `kind:llm`                  | ✅                           |
| Subagent       | `api.runtime.subagent.run`       | Playbook `kind:subagent`             | ✅                           |
| Skill          | `runEmbeddedAgent`               | Playbook `kind:skill`                | ✅                           |
| Notify         | `channel.outbound`               | Playbook notify + HITL               | ✅ 需 notify.targets         |
| HITL           | `managedFlows`                   | `createProductionHitlGate`           | ✅                           |
| IM 入站        | `message_received` hook          | `im_bridge.auto_on_message_received` | ✅ 默认 enterprise init 开启 |
| HTTP           | `registerHttpRoute`              | `/v1`, `/a2a`, `/mcp`, `/studio`     | ✅                           |
| Security audit | `registerSecurityAuditCollector` | `security-audit.ts`                  | ✅ 本轮注册                  |

Doctor 新增检查项：`openclaw_bridge_llm` / `openclaw_bridge_notify` / `openclaw_bridge_im`。

---

## 4. Foundry + AIP + 机器人网络

| Foundry/AIP 概念 | ClaWorks 组件                   | 完成度  | 优化方向                          |
| ---------------- | ------------------------------- | ------- | --------------------------------- |
| 语义本体         | OntologyEngine + Pack YAML      | **88%** | 统一 base vs core 文档            |
| 对象存储         | ObjectStore 版本化              | **88%** | PG 生产压测                       |
| 数据集成         | Connectors + Ingress            | **60%** | OT 去 simulate                    |
| 工作流/管道      | PlaybookEngine                  | **94%** | Pack action 注册 + 依赖解析已修复 |
| LLM on ontology  | llm + output_schema + voting    | **85%** | 更多 Pack 采用 schema             |
| Agent 网格       | A2A + a2a_delegate              | **80%** | mesh 运维与 HTTPS 强制            |
| 观测/血缘        | metrics + decision-log          | **75%** | OTEL 导出                         |
| 自然语言构建     | claworks-builder + setup_wizard | **75%** | onboarding 向导 Pack 已有         |

---

## 5. 基础通用业务闭环（Pack + 测试）

| 场景           | Pack / Playbook                            | 测试                   | 状态     |
| -------------- | ------------------------------------------ | ---------------------- | -------- |
| IM 意图分类    | `classify_im_to_business_event`            | e2e-smoke              | ✅       |
| Webhook 意图   | `classify_webhook_to_business_event`       | e2e-smoke              | ✅       |
| 告警→HITL→工单 | process-industry                           | closed-loop demo       | ✅       |
| 任务创建/通知  | enterprise-general                         | enterprise-biz-test #1 | ✅       |
| 审批 HITL      | enterprise-general                         | enterprise-biz-test #2 | ✅       |
| 故障响应+复盘  | enterprise-general                         | enterprise-biz-test #3 | ✅       |
| 会议纪要+KB    | enterprise-general                         | enterprise-biz-test #4 | ✅       |
| KB 检索        | base + memory-core                         | enterprise-biz-test #6 | ✅       |
| 日报           | enterprise-general + enterprise-foundation | enterprise-biz-test #8 | ✅ 37/37 |
| 商务 KB/报价   | enterprise-commercial                      | commercial-biz-test    | ✅       |
| RBAC deny 告警 | `handle_rbac_denied`                       | runtime tests          | ✅       |
| Pack 热重载    | `system_pack_reload`                       | http-smoke             | ✅       |

**Pack 分层（2026-05-23 修复）**：

- `enterprise-foundation`（L1）为 `enterprise-general` / `enterprise-commercial` 的**必选**依赖，提供 `query_daily_stats` 等 action handlers
- `loadInstalled` 自动解析 `requires` 并拓扑排序加载
- `createClaworksRuntime` 启动时调用 `applyPackContributions` 注册 Pack factory（此前仅 reload 路径注册，导致 action 步骤 fallback 到 WorkOrder stub）
- Pack manifest `entry: index.js` 在仅有 `index.ts` 时自动回退加载

**空壳说明**：`claworks-packs/enterprise` 为 L5 占位，实际企业能力在 `enterprise-general` / `enterprise-commercial`。

---

## 6. 完成度总评（2026-05-23）

| 层级              | 评分    | 判定                              |
| ----------------- | ------- | --------------------------------- |
| OpenClaw 架构对齐 | **93%** | 通过                              |
| 用户使用体验对齐  | **88%** | 通过（IM 需配渠道+notify）        |
| Foundry 数据/本体 | **84%** | 条件通过                          |
| AIP 编排/LLM      | **90%** | 通过                              |
| A2A 机器人网络    | **80%** | 试点就绪                          |
| 基础通用业务闭环  | **95%** | 通过（enterprise-biz-test 37/37） |
| 生产 hardened     | **78%** | 见 PRODUCTION-READINESS.md        |

---

## 7. 剩余 P0/P1（不含 Studio）

| 优先级 | 项                                                   |
| ------ | ---------------------------------------------------- | ---------------- |
| P0     | OT Connector 现场化（mqtt/opcua/modbus 非 simulate） |
| P1     | `pnpm claworks:smoke` + gateway:e2e 进 CI            |
| P1     | 向量 KB 生产默认路径（memory-core + repair）         |
| P1     | Extension 物理裁剪 apply                             |
| P1     | notify.targets 向导/ repair 自动从 feishu 账户推导   | ✅ repair 已实现 |
| P1     | `GET /v1/kb/status` + `POST /v1/kb/flush` REST       | ✅ 本轮补齐      |
| P2     | npm 发布、根包品牌化、OTEL                           |

---

## 8. 验收命令

```bash
pnpm claworks:runtime:test
pnpm claworks:smoke
node --import tsx scripts/claworks-enterprise-biz-test.mjs
CLAWORKS_INIT_SECURE=1 pnpm claworks:init
pnpm claworks:gateway
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:18800/v1/doctor
```

权威顺序：`OPENCLAW-ALIGNMENT-AUDIT.md`（本文）→ `PRODUCTION-READINESS.md` → `IMPLEMENTATION-STATUS.md`。
