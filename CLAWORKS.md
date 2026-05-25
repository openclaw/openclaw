# ClaWorks

**AI 业务编排机器人**，基于 OpenClaw fork 构建，为弱模型环境设计的工业级智能体系统。

生产部署与运维步骤见 **[DEPLOYMENT.md](DEPLOYMENT.md)**。

## 核心架构

```
IM / Webhook / Schedule / API
         ↓
  EventKernel（事件总线）
         ↓
 PlaybookEngine（Playbook 执行引擎）
    ├── StepExecutor（12+ 步骤类型）
    ├── CapabilityRegistry（215 能力）
    └── ObjectStore + KnowledgeBase
         ↓
  通知路由 → 飞书 / 钉钉 / Webhook
```

## 弱模型补偿策略

1. **RuleEngine**：关键词直接路由，0 LLM 调用
2. **ScaffoldEngine**：预制步骤脚本，弱模型照单执行
3. **StructuredOutput**：强制 JSON 输出 + 3 票投票机制
4. **CBR TF-IDF**：相似案例 few-shot，无需额外训练

## 自改进流水线

私域数据采集 → 导出 → **商业模型离线分析（人工）** → 生成进化包 → 导入热更新 → PlaybookSimulator 验证

### 自动化（runtime + base pack）

| 阶段         | 触发                                                                    | 行为                                                                                                         | 是否自动部署   |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------- |
| 学习机会检测 | `detectLearnOpportunities` / 负反馈 / stub 兜底                         | 发布 `autonomy.learn_opportunity`                                                                            | —              |
| 自治处理     | `autonomy.learn_opportunity` → `handleAutonomyLearnOpportunity`         | KB/CBR 写入、在线规则、CBR 复用提示                                                                          | —              |
| 知识缺口模拟 | `signal=knowledge_gap`                                                  | 发布 `evolution.simulation_requested` → `evolution.regression_requested` → `weak_model_regression_suite`     | 否             |
| 缺口批量导出 | 同上（24h 防抖）                                                        | `evolution.export_data`(7d) → KB `evolution_exports` + `evolution.gap_batch_exported`                        | 否             |
| 每周导出     | `evolution_weekly_export` cron 周日 02:00 CST                           | `evolution.export_data` → KB `evolution_exports` + 运维通知                                                  | 否             |
| 模拟蒸馏     | `POST /v1/evolution/simulate` 或 `evolution.simulation_requested`       | `evolution_simulation_pipeline` 弱模型回归 + 导出摘要 → KB `simulation_runs`                                 | 否             |
| 半自动草稿   | 知识缺口 / CBR 覆盖不足 + LLM 可用                                      | `EvolveEngine.proposeDraft` → KB `evolution_drafts` + `evolve.playbook_drafted` / `evolve.suggestions_ready` | **否**         |
| 沙盒导入     | `evolution.import_pack` / `POST /v1/evolution/import` + `sandbox: true` | 沙盒 load + 回归；通过后 `evolution.sandbox_ready_for_promotion` + SQLite pending                            | **否**（HITL） |
| 导入→回归    | `evolution_pack_import_and_verify`                                      | pack 热重载后 `evolution.regression_requested`                                                               | 视 pack 内容   |
| 草稿晋升     | `POST /v1/evolve/promote-draft` + `approved: true`                      | 写入 `user_evolved` pack；可选 `verify_after_deploy`（默认 true）                                            | HITL 批准后    |
| 沙盒晋升     | `POST /v1/evolution/promote` / `evolution.promote_sandbox`              | 生产 pack 热更新                                                                                             | HITL 批准后    |

### 仍需人工（商业模型 / 运维）

1. **联网环境**：从 KB `evolution_exports` 取出脱敏导出 JSON，用商业强模型分析并生成 `EvolutionPack`。
2. **导入**：`claworks evolution import` 或 `POST /v1/evolution/import`（生产路径需 HITL；可先 `sandbox: true` 验证）。
3. **草稿审核**：`GET /v1/evolve/drafts` 审阅 LLM 草稿，批准后 `promote-draft`。
4. **沙盒晋升**：收到 `evolution.sandbox_ready_for_promotion` 后确认 `promote` / `evolution.promote_sandbox`。

验收：`pnpm claworks:evolution:smoke`（进程内链路与 pending 持久化）；签收前另跑 `pnpm claworks:gateway:e2e`。

## Pack 生态（158+ 活跃 Playbook）

| Pack                   | Playbook 数 | 定位                                     |
| ---------------------- | ----------- | ---------------------------------------- |
| base                   | 103+        | 平台基础（通知、审批、告警、Agent 自治） |
| enterprise-general     | 16          | 通用企业（任务、工单、事件）             |
| process-industry       | 8           | 流程行业（班次、设备、巡检）             |
| enterprise-commercial  | 5           | 商业运营（报价、投标）                   |
| enterprise-analytics   | 5           | 数据分析（时序、BI 导出）                |
| daily-report           | 5           | 飞书日报分析                             |
| enterprise-learning    | 3           | 学习飞轮（复盘、CBR）                    |
| integration-templates  | 4           | 连接器模板（DB / REST / Webhook）        |
| personal-enterprise    | 4           | 知识库维护（KB 摄取、精炼）              |
| enterprise-performance | 2           | 绩效评分                                 |

## 快速开始

```bash
pnpm install
pnpm dev                                     # 启动开发模式
claworks init --profile enterprise           # 10 分钟零门槛初始化（industrial / daily-report）；init 后会自动加载对应 Pack 组合
claworks doctor --fix                        # 诊断并自动修复配置、Pack、LLM
pnpm openclaw doctor                         # OpenClaw 侧诊断
pnpm test packages/claworks-runtime          # 运行测试
```

## 测试

397 个单元测试，89 个测试文件，全部通过。覆盖 EventKernel、PlaybookEngine、StepExecutor、CapabilityRegistry、ObjectStore、KnowledgeBase、A2A、RuleEngine、ScaffoldEngine、进化流水线、init CLI、Pack Profile 热切换、W3C traceparent、弱模型回归 CI 等核心模块。

（签收快照见 `docs/SIGNOFF-SNAPSHOT.md`。）

---

## 系统评级（交付快照）

| 维度       | 分数 | 依据                                                                                |
| ---------- | ---- | ----------------------------------------------------------------------------------- |
| 感知       | 4/5  | IM/Webhook/Schedule 多入口 + perceive.intent 意图分类，弱模型场景有 RuleEngine 兜底 |
| 交流       | 4/5  | comms.send / notify.dispatch 多渠道通知，HITL 人机协同步骤完备                      |
| 记忆       | 4/5  | ObjectStore + KB + CBR + memory_read/write 步骤，用户画像持久化                     |
| 学习       | 4/5  | 进化流水线（evolve.\*）、CBR 摄取、weak_model_regression 自测闭环                   |
| 执行       | 5/5  | 215+ 能力 + 12+ 步骤类型 + Pack Profile 热切换，397 测试全绿                        |
| 自主       | 4/5  | AutonomyEngine 心跳/空闲/缺口检测，ScaffoldEngine 弱模型照单执行                    |
| 安全       | 4/5  | RBAC、HITL 门禁、production_mode fail-closed、审计日志                              |
| 可观测性   | 4/5  | LOG_LEVEL + metrics + W3C traceparent 贯通；OTEL 导出器仍待加强                     |
| 弱模型补偿 | 5/5  | RuleEngine + Scaffold + StructuredOutput 投票 + CBR few-shot 四层补偿               |
| 生态扩展   | 4/5  | Pack 热加载 + scriptLibrary + OpenClaw skill bridge 双轨 skill 池                   |

**综合：4.1 / 5** — 工业编排 MVP 已可交付，弱模型场景具备生产可用性。

### 建议后续演进（非 bug）

1. **OTEL EventKernel 桥接**：traceparent 已贯通；接 diagnostics-otel span 见 `docs/OBSERVABILITY.md`
2. **弱模型 PR required check**：workflow 已接 PR；GitHub branch protection 待维护者启用
3. **行业 Profile 一键 UI**：Setup Wizard / 管理台可视化切换 industrial / enterprise / daily-report
4. **多 trigger Playbook 语法**：YAML parser 支持 `triggers: [...]` 数组
5. **Studio React 编辑器**：静态 `/studio` 已有，全功能编辑器未做
6. **Feishu live E2E**：需飞书应用凭证 + 测试群（见 `docs/OBSERVABILITY.md` CI 节）
7. **`@claworks/runtime` npm 公开发布**：`pnpm claworks:runtime:publish:dry-run` 验证 tarball；正式发布待审批
