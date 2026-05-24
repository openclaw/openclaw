# ClaWorks ↔ OpenClaw 全维度对齐审计

**更新**：2026-05-24  
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

| 用户能力   | OpenClaw 用法             | ClaWorks 等价                                   | 对齐度  | Gap                                |
| ---------- | ------------------------- | ----------------------------------------------- | ------- | ---------------------------------- |
| CLI 启动   | `openclaw gateway`        | `claworks gateway` / `pnpm claworks:gateway`    | **98%** | 根包 `claworks`，无 `openclaw` bin |
| 配置向导   | `openclaw configure`      | ✅ 继承 + claworks 默认                         | **90%** | 机器人 Pack 需 IM/文档引导         |
| IM 对话    | 渠道插件 → agent 自动回复 | ✅ 双路径：OpenClaw agent **或** IM→EventKernel | **85%** | auto-bridge 需 init/repair 开启    |
| Skills     | ClawHub + workspace       | ✅ 4 个 robot skills + OpenClaw skills          | **90%** | Builder 依赖 cw\_\* 工具           |
| Agent 工具 | 插件 registerTool         | ✅ 48× `cw_*`                                   | **95%** | 远程 extension 22 工具             |
| HITL/审批  | managedFlows + 渠道       | ✅ Playbook HITL + managedFlows 桥              | **85%** | 无 Studio 审批 UI                  |
| Webhook    | webhooks 插件             | ✅ `/v1/bridge/webhook` + classify              | **90%** | Ingress 策略需配置                 |
| 流式回复   | block/preview streaming   | ✅ 继承 Feishu 等渠道                           | **90%** | Playbook notify 非流式             |
| Doctor     | 健康检查 + fix            | ✅ + ClaWorks 专项 checks                       | **90%** | —                                  |
| 插件安装   | `plugins install`         | ✅ 白名单 bundled + 外仓 extension              | **85%** | 磁盘未物理裁剪                     |

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

Doctor 新增检查项：`openclaw_bridge_llm` / `openclaw_bridge_notify` / `openclaw_bridge_im`（用户可见文案为 Gateway LLM bridge，非 OpenClaw 品牌）。

**Onboarding 白标（2026-05-24）**：`wizardT`/`formatCliCommand`/`product-surface` 覆盖 setup/configure/doctor 首屏与 next steps；`onboard-remote` 默认 WS 18800；`claworks:setup` 一键 doctor→init→onboard。详见 `REBRAND-TO-CLAWORKS.md` onboarding 小节。

---

## 4. Foundry + AIP + 机器人网络

| Foundry/AIP 概念 | ClaWorks 组件                   | 完成度  | 优化方向                          |
| ---------------- | ------------------------------- | ------- | --------------------------------- |
| 语义本体         | OntologyEngine + Pack YAML      | **88%** | 统一 base vs core 文档            |
| 对象存储         | ObjectStore 版本化              | **88%** | PG 生产压测                       |
| 数据集成         | Connectors + Ingress            | **75%** | repair/doctor 强制去 simulate     |
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

| 优先级 | 项                                                    | 状态                                      |
| ------ | ----------------------------------------------------- | ----------------------------------------- |
| P0     | OT Connector 现场化（mqtt/opcua/modbus 非 simulate）  | ✅ 2026-05-24 repair + doctor + docs      |
| P0     | product health checks 接入 doctor --fix / lint        | ✅ 2026-05-23                             |
| P0     | npm scripts 与文档对齐（setup/start/doctor/kb-smoke） | ✅ 2026-05-23                             |
| P0     | Doctor/configure intro 产品化文案                     | ✅ 2026-05-23                             |
| P0     | `POST /v1/doctor?fix=true` runtime fix                | ✅ 2026-05-23                             |
| P1     | `pnpm claworks:smoke` + gateway:e2e 进 CI             | ✅ 本地全绿                               |
| P1     | 向量 KB 生产默认路径（memory-core + repair）          | ✅ CLAWORKS_PRODUCT=1 repair 自动 wiring  |
| P1     | Extension 物理裁剪 apply                              | ✅ `pnpm claworks:prune-extensions:apply` |
| P1     | notify.targets 向导/ repair 自动从 feishu 账户推导    | ✅ repair 已实现                          |
| P1     | `GET /v1/kb/status` + `POST /v1/kb/flush` REST        | ✅ 本轮补齐                               |
| P2     | npm 发布、OTEL                                        | 待办（根包已品牌化 `claworks`）           |

---

## 8. 运维与开箱即用（OpenClaw 对齐专节）

### 8.1 命令对照（权威）

| 场景       | OpenClaw                     | ClaWorks                                                           | 对齐     |
| ---------- | ---------------------------- | ------------------------------------------------------------------ | -------- |
| 首次初始化 | `openclaw setup` / `onboard` | `pnpm claworks:init` + `pnpm claworks:setup`                       | ✅       |
| 配置修复   | `openclaw doctor --fix`      | `pnpm claworks:doctor:fix` / `pnpm claworks:repair`                | ✅       |
| 健康检查   | `openclaw doctor`            | `pnpm claworks:doctor`                                             | ✅       |
| 启动网关   | `openclaw gateway run`       | `pnpm claworks:start` / `pnpm claworks:gateway`                    | ✅       |
| 配置向导   | `openclaw configure`         | `claworks configure`（继承，intro 已产品化）                       | ✅       |
| 网关服务   | `openclaw gateway install`   | `claworks gateway install`（LaunchAgent `ai.claworks.gateway`）    | ✅       |
| 数据库迁移 | —                            | `pnpm claworks:migrate`（PostgreSQL DDL，**非** OpenClaw migrate） | 产品专属 |
| 验收       | —                            | `pnpm claworks:smoke` / `pnpm claworks:gateway:e2e`                | 产品专属 |

**Repair 真源**：`packages/claworks-runtime/src/claworks/product-config-repair.ts`（CLI doctor、claworks:repair、init、e2e 共用）。

**Bootstrap 差异**：一键 repair/init 默认走 `claworks start`（`ensureClaworksProductReady`）；裸 `gateway run` 不自动 repair——运维文档应优先推荐 `pnpm claworks:start`。

### 8.2 Doctor 双层模型

| 层             | 入口                                              | 职责                                                         |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| OpenClaw 核心  | `claworks doctor` → `doctor-health-contributions` | 网关/auth/插件/渠道/结构化 health checks                     |
| ClaWorks 产品  | 同上 + `runClaworksProductDoctorHealth`           | robot 插件、packs、端口 18800、LaunchAgent 隔离              |
| Runtime 进程内 | `POST /v1/doctor` / `cw_doctor_run`               | playbooks/ontology/KB/connectors；`?fix=true` 热修复 runtime |

### 8.3 推荐开箱路径（生产前）

```bash
CLAWORKS_INIT_SECURE=1 pnpm claworks:init
pnpm claworks:setup                    # doctor --fix + onboard
CLAWORKS_VECTOR_KB=1 pnpm claworks:repair
pnpm claworks:start                    # 非 claworks:gateway（含 bootstrap）
pnpm claworks:smoke
pnpm claworks:gateway:e2e
```

个人工作 profile：`pnpm claworks:repair:personal` → `pnpm claworks:personal:verify` → `pnpm claworks:kb-smoke`。

### 8.4 开箱即用评分（2026-05-24）

| 维度             | 评分    | 说明                                                                                                                          |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CLI 命令面       | **99%** | 继承 OpenClaw + 产品 npm aliases；help/channels/qr/wizard i18n/ doctor lint/config issue/update/onboard/插件诊断 提示已产品化 |
| Doctor/fix       | **92%** | 双层 + 端口/LaunchAgent 隔离 repair                                                                                           |
| 零配置启动       | **75%** | 仍需 claworks-packs 外仓 + 模型/飞书凭据                                                                                      |
| 运维可观测       | **85%** | `/v1/health`、metrics、decision-log；无 OTEL                                                                                  |
| 与 OpenClaw 共存 | **95%** | 18800 / ~/.claworks / ai.claworks.gateway                                                                                     |

### 8.5 用户可见文案产品化（2026-05-24）

| 区域                                                                                                       | 状态 | 说明                                                              |
| ---------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------- |
| `formatHelpExamples` / help-format                                                                         | ✅   | `replaceCliName` 覆盖 help 示例命令                               |
| `qr-cli` / `channels add` / `channels list`                                                                | ✅   | 命令字符串经 `formatCliCommand` / `replaceCliName` 产品化         |
| Wizard i18n（en / zh-CN / zh-TW）                                                                          | ✅   | `wizardT` → `applyClaworksWizardCopy` → `replaceEmbeddedCliNames` |
| `runtime-guard` Node 版本错误                                                                              | ✅   | `resolveProductCliName()` 动态 CLI 名                             |
| IM abort 触发词                                                                                            | ✅   | 新增 `stop clawworks` / `claworks stop`（保留 openclaw 变体）     |
| config issue / doctor --lint 输出                                                                          | ✅   | `issue-format` + `doctor-lint` 经 `productizeUserCopy`            |
| `config/validation.ts` 校验消息                                                                            | ✅   | web_search / channel / plugins install 提示经 `formatCliCommand`  |
| gateway 连接错误 / daemon 版本 mismatch                                                                    | ✅   | `formatCliCommand` / `productizeUserCopy`                         |
| update 后 repair 指引 / onboard 提示                                                                       | ✅   | `formatCliCommand` 覆盖 doctor/update/configure                   |
| 插件 discovery / binding / registry 诊断                                                                   | ✅   | `formatCliCommand` / `productizeUserCopy`                         |
| channel 选择错误 / LaunchAgent actionHint                                                                  | ✅   | `formatCliCommand`                                                |
| Extension doctor-contract（telegram/discord/matrix）                                                       | ✅   | `formatCliCommand` 覆盖 legacy 规则与 Matrix 诊断                 |
| Extension doctor-contract（slack/zalouser/googlechat/voice-call/memory-wiki/elevenlabs/google-meet/codex） | ✅   | 第二批 bundled 插件 legacy 规则与 voice-call 运行时警告           |
| `schema.help.ts` / configure UI hints 显示层                                                               | ✅   | `buildBaseHints()` 经 `productizeUserCopy` 产品化 help 文案       |
| claworks-robot `cw_update_config` 描述                                                                     | ✅   | `claworks.json` 替代 openclaw.json                                |
| update-runner progress / tui 内部日志                                                                      | ⏭️   | 纯内部，跳过                                                      |

**遗留（下轮分批）**

| 区域                                                        | 状态 | 说明                                                                     |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------ |
| Extension doctor-contract（ollama/vllm/plugin-sdk ssrf 等） | 🔲   | 少量 provider/index 与 SDK legacy 规则仍裸 `openclaw configure` / doctor |
| `schema.help.ts` 静态源字符串                               | —    | 显示层已产品化；源文件仍保留 openclaw 真源供 upstream 合并               |
| `doctor-core-checks` / gateway client 等 core 诊断          | 🔲   | 部分 fixHint 仍硬编码，非 extension 热路径                               |
| `update-cli` progress 内部日志                              | ⏭️   | 审计已标跳过                                                             |
| feishu / webhooks extension                                 | —    | 无 doctor-contract 或 onboarding 裸 `openclaw` 提示                      |

---

## 9. 验收命令

```bash
pnpm claworks:runtime:test
pnpm claworks:smoke
node --import tsx scripts/claworks-enterprise-biz-test.mjs
CLAWORKS_INIT_SECURE=1 pnpm claworks:init
pnpm claworks:start
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:18800/v1/doctor
curl -X POST -H "Authorization: Bearer $KEY" "http://127.0.0.1:18800/v1/doctor?fix=true"
```

权威顺序：`OPENCLAW-ALIGNMENT-AUDIT.md`（本文）→ `PRODUCTION-READINESS.md` → `IMPLEMENTATION-STATUS.md`。
