---
read_when:
  - 你想对照 OpenAI《Harness engineering》文章检查 OpenClaw 的落地程度
  - 你想知道 OpenClaw 的 harness 主线已经做到哪里、还缺什么
  - 你想把后续工作整理成一份可执行的 Todo 清单
status: active
summary: 对照 OpenAI《Harness engineering》文章，对 OpenClaw 当前实现做已满足 / 部分满足 / 未满足评估，并给出下一步 Todo
owner: OpenClaw harness
freshness: monthly
last_reviewed: "2026-03-25"
title: Harness Engineering 对照清单
---

# Harness Engineering 对照清单

这份文档用来对照 OpenAI 文章
[Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
检查 OpenClaw 当前实现。

目标不是逐句翻译文章，而是把文章里的要求改写成一份工程对照清单：

- 哪些已经满足
- 哪些只做到第一版
- 哪些还没有开始
- 下一步最值得做什么

## 一句话结论

OpenClaw 现在已经做出了较完整的 harness control plane：

- 任务画像
- prompt budget
- workspace policy 发现与切片
- verify / failure / retry 闭环
- tool / skill 裁剪
- delegation profile
- failure-to-rule suggestions
- cron health checks suggestion / install
- repo knowledge index / exec plans / tech debt

如果只看文章最核心的 harness 原则，OpenClaw 已经满足了很大一块。

如果按文章里更完整的 `agent-first engineering system` 来看，OpenClaw 还缺：

- 文档和架构的机械校验
- UI / 浏览器 / observability 可见性
- 长期趋势面板和更强的自动治理
- 更完整的 PR / review / merge 自动化

## 状态定义

- `已满足`：已经形成正式能力，并有代码、测试或运行态证据
- `部分满足`：方向正确，已有第一版实现，但还没形成完整产品能力
- `未满足`：文章要求对应的能力还没有正式落地
- `刻意暂缓`：文章里提到但当前阶段不该优先做的事情

## 对照表

| 文章要求                                                 | OpenClaw 当前状态                                                                                                                                               | 状态       | 证据                                                                                                                                                                                                                     | 缺口                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 按任务缩小解空间，而不是给 agent 过宽上下文              | 已有 task profile、profile-to-tool pack、profile-to-skill pack、dynamic tool pruning、dynamic skill pruning                                                     | `已满足`   | `src/agents/task-profile.ts`、`src/agents/task-profile-tool-pack.ts`、`src/agents/task-profile-skill-pack.ts`、`src/agents/dynamic-tool-pruning.ts`、`src/agents/dynamic-skill-pruning.ts`                               | 还缺长期效果统计和 dashboard                                  |
| 规则文件应成为轻量、稳定的 harness 入口                  | 已有 `AGENTS.md`、`OPENCLAW.md`、`CLAUDE.md` 发现、注入、切片；并且会报告来源、优先级、合并顺序和冲突提示                                                       | `已满足`   | `src/agents/workspace.ts`、`src/agents/system-prompt-report.ts`、`docs/concepts/agent-workspace.md`                                                                                                                      | 切片和冲突启发式仍可继续细化                                  |
| 不要只执行，要有 verify 闭环                             | 已有 verify runner core                                                                                                                                         | `已满足`   | `src/agents/verify-report.ts`、`/context` 中的 `Verify runner`                                                                                                                                                           | 目前主要是命令型验证，文件/截图/报告型验证还不够              |
| 失败必须结构化，不能只是日志                             | 已有 failure reason 和 retry budget                                                                                                                             | `已满足`   | `src/agents/failure-report.ts`、`src/agents/retry-report.ts`、`/context` 中的 `Failure reason` 和 `Retry budget`                                                                                                         | failure taxonomy 还能继续细化                                 |
| harness 必须可观测、可解释                               | 已有 prompt budget、task profile、workspace policy、policy slicing、verify、failure、retry、delegation 的统一报告，并新增 workspace health dashboard / 趋势汇总 | `已满足`   | `src/agents/system-prompt-report.ts`、`src/auto-reply/reply/commands-context-report.ts`、`src/agents/workspace-health-dashboard.ts`                                                                                      | dashboard 仍可继续扩到 UI / observability / archive 面板      |
| workspace policy 不能全塞，要切片                        | 已有 workspace policy discovery 和 policy slicing                                                                                                               | `已满足`   | `src/agents/workspace.ts`、`src/agents/pi-embedded-helpers/bootstrap.ts`                                                                                                                                                 | 目前切片规则仍较保守                                          |
| subagent 要可解释，不要神秘 delegation                   | 已有 delegation profile                                                                                                                                         | `部分满足` | `src/agents/delegation-profile.ts`、`/context` 中的 `Delegation profile`                                                                                                                                                 | 还没做到更完整的多模型、多策略 delegation 平台                |
| 失败经验要沉淀成规则候选                                 | 已有 failure-to-rule suggestions，并支持显式人工确认后回写 policy                                                                                               | `已满足`   | `src/agents/failure-rule-suggestions.ts`、`src/agents/policy-writeback.ts`、`/context rule apply`                                                                                                                        | 还没有批量聚合和自动推荐合并策略                              |
| cron 要用于长期治理、垃圾回收、体检                      | 已有 cron health checks suggestion，并支持一键安装/更新默认健康巡检作业；dashboard 已能提供长期趋势视角；doc gardening 也能安装成隔离作业                       | `已满足`   | `src/agents/cron-health-checks.ts`、`src/agents/cron-health-check-install.ts`、`src/agents/doc-gardening.ts`、`src/agents/doc-gardening-install.ts`、`/context cron install`、`/context health`、`/context docs install` | 还没有归档面板和更自动的多作业治理界面                        |
| repo 内知识应是 system of record，而不是散在聊天和人脑里 | 已建立 docs index、`exec-plans/`、`tech-debt/`、关键文档的 owner / freshness / last reviewed 元信息，以及 doc gardening 自动巡检安装流                          | `已满足`   | `docs/concepts/docs-index.md`、`docs/exec-plans/`、`docs/tech-debt/`、`src/agents/doc-gardening.ts`、`src/agents/doc-gardening-install.ts`                                                                               | 还没有 quality scorecards 和自动 freshness lint               |
| 文档和规则要能机械校验                                   | 已有 repo knowledge guard，检查关键文档 frontmatter、freshness、命名和 docs index 入口                                                                          | `已满足`   | `scripts/check-repo-knowledge-guards.mjs`、`test/repo-knowledge-guards.test.ts`、`pnpm lint:repo-knowledge`                                                                                                              | 还缺更广覆盖的 dead-link / coverage 汇总                      |
| 架构边界和 taste 要编码进 lint / tests / CI              | 已有 harness core boundary guard、security audit remediation guard，并接入 `pnpm check`                                                                         | `已满足`   | `scripts/check-harness-core-boundaries.mjs`、`scripts/check-security-audit-remediation.mjs`、`test/harness-core-boundaries.test.ts`、`test/security-audit-remediation.test.ts`                                           | 还缺更广范围的 structural tests 与全仓 layering 规则          |
| 应用、浏览器、UI、观测栈要对 agent 可见                  | 当前没有文章里那套 CDP / 截图 / traces / logs 查询体系                                                                                                          | `未满足`   | 仅有 harness reporting                                                                                                                                                                                                   | 缺 UI / browser harness 和 observability 接口                 |
| review、修复、再验证应尽量 agent 化                      | 当前主要是运行时和上下文治理改造                                                                                                                                | `未满足`   | 无完整 PR / review / merge automation                                                                                                                                                                                    | 缺 agent-to-agent review、auto-fix、reverify、auto-merge 流程 |
| 不要过早做厚 DSL 和复杂模型路由                          | 当前 roadmap 明确 deferred                                                                                                                                      | `刻意暂缓` | `docs/concepts/harness-roadmap.md`                                                                                                                                                                                       | 当前不应优先投入                                              |

## 当前最强的部分

如果只看文章最核心的那一层，OpenClaw 已经比较强的是：

- `更薄`
  - task profile
  - policy slicing
  - dynamic tool / skill pruning
- `更硬`
  - verify runner
  - structured failure
  - retry budget
- `更可解释`
  - `/context`
  - delegation profile
  - failure-to-rule suggestions
- `更有治理倾向`
  - cron health check suggestion
  - workspace policy discovery

这意味着 OpenClaw 已经从“隐性 prompt 堆叠”走到了“显性 harness 控制面”。

## 还没做到的真正差距

文章真正更重的部分，不是单个 runtime feature，而是把整个代码仓库和交付流程都改造成 agent-first 系统。OpenClaw 当前最明显的缺口集中在下面几类。

### 1. Repo 级知识系统还不够完整

现在已经补上了 docs index、`exec-plans/`、`tech-debt/` 和关键文档元信息，但还没有形成更自动化的知识治理体系：

- quality scorecards
- 结构化 cross-linking
- 可校验的 freshness / ownership

### 2. 机械化架构约束还不够强

现在已经补上了第一版机械约束：

- harness core import boundary guard
- repo knowledge metadata / naming guard
- security audit remediation guard

但仓库本身还没有大量把更广泛的架构和 taste 写进 lint / tests / CI：

- import 边界
- 目录职责
- 文件大小约束
- naming rules
- error message remediation 规范

### 3. 长期自动治理还只是第一步

现在已经有 `Failure-to-rule suggestions` 的人工确认回写流，以及 `Cron health checks` 的安装/更新流，但长期治理还没有完全平台化。

更完整的闭环还没形成：

- 定期巡检真正跑起来
- 长期指标在 dashboard 中可见
- 规则候选的批量聚合与去重

### 4. UI / 浏览器 / observability 还没进入 harness

文章里非常强调：

- UI 可以截图和驱动
- 浏览器状态可见
- logs / metrics / traces 可查询

OpenClaw 现在主要还是 harness runtime 可见，还没有把这些更外层的工程环境纳入系统。

## 下一步 Todo

下面这份 Todo 不是重新发明大 roadmap，而是文章对照之后最值得继续做的“后半场”。

### P0：把已经有的建议变成闭环

- [x] 把 `Failure-to-rule suggestions` 接到“人工确认后写回 policy”的流程
- [x] 把 `Cron health checks` 从建议升级成默认可运行的 cron 模板
- [x] 给 `workspace policy` 增加更明确的优先级、来源和冲突说明
- [x] 把 `CLAUDE.md` 纳入与 `AGENTS.md / OPENCLAW.md` 一致的一等公民链路

**验收信号**

- agent 失败后不只会给建议，还能生成可确认的 policy patch
- cron 巡检不只是说明文字，而是能实际运行并产出固定格式报告
- `/context` 能清楚解释规则来源和合并结果

**当前证据**

- `src/agents/policy-writeback.ts`
- `src/agents/cron-health-check-install.ts`
- `src/agents/workspace.ts`
- `/context rule apply ...`
- `/context cron install`

### P1：把 repo 变成真正的知识系统

- [x] 建立 docs index，把核心 concepts / runbooks / plans 串起来
- [x] 建立 `exec-plans/` 或等价目录，沉淀执行计划而不是只留在聊天里
- [x] 建立 `tech-debt/` 或等价结构，记录已知问题、权衡和后续动作
- [x] 为关键文档增加 owner / freshness / last reviewed 元信息

**验收信号**

- 新 agent 进入仓库后，能从 repo 内拿到主要上下文，而不是依赖口头补充
- 关键文档有明确入口、更新时间和责任边界

**当前证据**

- `docs/concepts/docs-index.md`
- `docs/exec-plans/README.md`
- `docs/exec-plans/harness-agent-first-system.md`
- `docs/tech-debt/README.md`
- `docs/tech-debt/harness-platform-gaps.md`
- `docs/concepts/harness-roadmap.md`
- `docs/concepts/agent-workspace.md`
- `docs/concepts/system-prompt.md`

### P2：把架构和 taste 编码进机械约束

- [x] 增加 custom lint，约束目录边界和依赖方向
- [x] 增加 structural tests，约束关键模块的 import / layering
- [x] 增加文件大小 / 命名 / 错误信息 remediation 规则
- [x] 把部分“口头 code review 偏好”收编到 lint 或 CI

**验收信号**

- code review 里重复出现的机械问题显著减少
- agent 在本地就能更早被结构化约束拦住，而不是等人指出来

**当前证据**

- `scripts/check-harness-core-boundaries.mjs`
- `scripts/check-repo-knowledge-guards.mjs`
- `scripts/check-security-audit-remediation.mjs`
- `test/harness-core-boundaries.test.ts`
- `test/repo-knowledge-guards.test.ts`
- `test/security-audit-remediation.test.ts`
- `package.json` 中的 `pnpm check`、`pnpm lint:harness:core-boundaries`、`pnpm lint:repo-knowledge`、`pnpm lint:security:audit-remediation`

### P3：把长期治理做成平台能力

- [x] 建立 workspace health dashboard
- [x] 汇总 profile 级别的成功率、token 成本、wall time、retry 使用情况
- [x] 对 prompt budget / failure reason / retry reason 做长期趋势分析
- [x] 建立 doc gardening / cleanup automation

**验收信号**

- 不只是单次 `/context` 可见，而是能看到长期趋势
- harness drift 会被周期性发现，而不是出问题后才知道

**当前证据**

- `src/agents/workspace-health-dashboard.ts`
- `src/agents/workspace-health-dashboard.test.ts`
- `src/agents/doc-gardening.ts`
- `src/agents/doc-gardening-install.ts`
- `src/agents/doc-gardening.test.ts`
- `src/agents/doc-gardening-install.test.ts`
- `src/auto-reply/reply/commands-context-report.ts`
- `src/auto-reply/reply/commands-context-report.test.ts`
- `/context health`
- `/context health json`
- `/context docs install`

### P4：把更外层工程环境也纳入 harness

- [ ] 研究如何把 browser / UI / app state 纳入 agent 可见面
- [ ] 研究如何把 logs / metrics / traces 纳入 agent 查询接口
- [ ] 评估 review / reverify / merge 的自动化闭环

**验收信号**

- agent 不只会改代码，还能更独立地复现问题、检查运行态、验证真实用户路径

### P5：把 harness core 提升成 role-scoped build loop

这一阶段对应 Anthropic 那篇长时间应用开发文章里最关键的下一跳：

- planner
- builder
- evaluator
- contract artifact
- richer evaluator packs

OpenClaw 现在已经有足够强的 control plane，所以 P5 的重点不是再造一个重 orchestrator，而是复用已有能力，增加一条更薄的任务级 recipe。

- [x] 增加 `planner / builder / evaluator` 角色预设
- [x] 建立稳定的 build-run artifact root 和 schema
- [x] 让 spawn path 按角色自动收紧工具面和验证姿态
- [ ] 增加 `verify-pack.json`，先支持 `exec / logs / report`
- [ ] 增加 browser-backed evaluator pack
- [ ] 补一份 manual role-scoped build walkthrough

**验收信号**

- 长时间 build 任务能显式声明 `planner / builder / evaluator`
- planner、builder、evaluator 之间通过稳定 artifact 交接，而不是只靠聊天上下文
- evaluator 能基于 richer checks 拦下不达标结果
- 整个 loop 能在没有厚 DSL 的情况下运行和调试

**当前证据 / 起点**

- `docs/zh-CN/concepts/anthropic-long-running-harness-checklist.md`
- `docs/exec-plans/role-scoped-build-loop.md`
- `docs/exec-plans/role-scoped-build-loop-phase-1-backlog.md`
- `src/agents/subagent-capabilities.ts`
- `src/agents/build-runs.ts`
- `src/agents/build-runs.test.ts`
- `src/agents/delegation-profile.ts`
- `src/agents/tools/sessions-spawn-tool.ts`
- `src/agents/pi-tools.policy.ts`
- `src/agents/openclaw-tools.subagents.sessions-spawn.role-preset.test.ts`
- `/context` 中的 `Delegation profile: ... preset=planner|builder|evaluator`
- builder preset 会回到标准 coding prompt，其它 build-loop 角色默认保持 minimal prompt
- spawn path 会继承 `buildRunId / buildRunDir`，并把 artifact root 提示注入 child system prompt

## 建议的推进顺序

如果只看文章对照后最值得做的顺序，我建议是：

1. 先做 `P5` 的 role-scoped build loop Phase 1
2. 再把 `P4` 的 browser / observability surface 接成 evaluator pack
3. 最后再扩到更外层的 review / reverify / merge automation

原因很简单：

- `P5` 才是把现有 harness core 变成长任务 build harness 的最大杠杆
- `P4` 里最重要的价值，其实是给 evaluator 提供更丰富的真实检查手段
- 更外层自动化应该建立在角色、artifact 和 contract 已经稳定之后

## 最后结论

OpenClaw 现在已经做到了这篇文章最关键的一层，而且已经补完了 P0、P1、P2 的第一版：

- 更薄
- 更硬
- 更可解释
- 更按任务裁剪
- 更完整的 policy 闭环
- 更明确的 repo knowledge 入口

但还没完全做到文章想要的终局：

把整个仓库、交付流程、观测系统和长期治理机制，一起做成 `agent-first engineering system`。

这份文档的意义就是把这个差距显式化，避免后续继续只做 runtime feature，却忽略了更大的系统化建设。

而 Anthropic 那篇长任务文章，则进一步说明了下一阶段为什么应该进入 `P5`：

- planner / builder / evaluator
- contract artifact
- richer evaluator packs
