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

私域数据采集 → 导出 → 商业模型分析 → 生成进化包 → 导入热更新 → PlaybookSimulator 验证

- **半自动草稿**：`autonomy.learn_opportunity`（知识缺口 / CBR 覆盖不足）触发 `EvolveEngine.proposeDraft`，YAML 写入 KB `evolution_drafts`（`pending_review`），发布 `evolve.playbook_drafted`，**不自动部署**。
- **沙盒导入**：`evolution.import_pack` 或 `POST /v1/evolution/import` 传 `sandbox: true` / `simulate_only: true`，Playbook 仅 load 到运行时沙盒源、跑干跑回归；通过后发布 `evolution.sandbox_ready_for_promotion` 等待 HITL 晋升，**不自动写入生产 Pack**。
- **模拟蒸馏**：`POST /v1/evolution/simulate`（或发布 `evolution.simulation_requested`）触发端到端弱模型回归 + 导出；摘要写入 KB `simulation_runs`。
- **每周导出**：`evolution_weekly_export` 定时（周日 02:00）调用 `evolution.export_data`，运维在联网环境用商业模型处理后再 `claworks evolution import`。
- **导入→回归闭环**：`evolution_pack_import_and_verify` 在 pack 热重载后发布 `evolution.regression_requested`，由 `weak_model_regression_suite` 自动跑弱模型意图回归。

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

395 个单元测试，89 个测试文件，全部通过。覆盖 EventKernel、PlaybookEngine、StepExecutor、CapabilityRegistry、ObjectStore、KnowledgeBase、A2A、RuleEngine、ScaffoldEngine、进化流水线、init CLI、Pack Profile 热切换、W3C traceparent、弱模型回归 CI 等核心模块。

（签收快照见 `docs/SIGNOFF-SNAPSHOT.md`。）

---

## 系统评级（交付快照）

| 维度       | 分数 | 依据                                                                                |
| ---------- | ---- | ----------------------------------------------------------------------------------- |
| 感知       | 4/5  | IM/Webhook/Schedule 多入口 + perceive.intent 意图分类，弱模型场景有 RuleEngine 兜底 |
| 交流       | 4/5  | comms.send / notify.dispatch 多渠道通知，HITL 人机协同步骤完备                      |
| 记忆       | 4/5  | ObjectStore + KB + CBR + memory_read/write 步骤，用户画像持久化                     |
| 学习       | 4/5  | 进化流水线（evolve.\*）、CBR 摄取、weak_model_regression 自测闭环                   |
| 执行       | 5/5  | 215+ 能力 + 12+ 步骤类型 + Pack Profile 热切换，395 测试全绿                        |
| 自主       | 4/5  | AutonomyEngine 心跳/空闲/缺口检测，ScaffoldEngine 弱模型照单执行                    |
| 安全       | 4/5  | RBAC、HITL 门禁、production_mode fail-closed、审计日志                              |
| 可观测性   | 4/5  | LOG_LEVEL + metrics + W3C traceparent 贯通；OTEL 导出器仍待加强                     |
| 弱模型补偿 | 5/5  | RuleEngine + Scaffold + StructuredOutput 投票 + CBR few-shot 四层补偿               |
| 生态扩展   | 4/5  | Pack 热加载 + scriptLibrary + OpenClaw skill bridge 双轨 skill 池                   |

**综合：4.1 / 5** — 工业编排 MVP 已可交付，弱模型场景具备生产可用性。

### 建议后续演进（非 bug）

1. **OTEL 导出器**：traceparent 已贯通，接 collector / diagnostics-otel 插件
2. **弱模型 PR 门禁**：nightly CI 已有；PR merge block 待接
3. **行业 Profile 一键 UI**：Setup Wizard / 管理台可视化切换 industrial / enterprise / daily-report
4. **多 trigger Playbook 语法**：YAML parser 支持 `triggers: [...]` 数组
5. **Studio React 编辑器**：静态 `/studio` 已有，全功能编辑器未做
