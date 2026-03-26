---
summary: 对照 Anthropic《Harness design for long-running application development》文章，检查 OpenClaw 在长时间应用开发 harness 上的当前状态与下一步计划
read_when:
  - 你想对照 Anthropic 的长任务 harness 文章检查 OpenClaw 的差距
  - 你想知道 OpenClaw 下一阶段为什么要做 planner / builder / evaluator
  - 你想把 role-scoped build loop 变成一份明确的 P5 backlog
owner: OpenClaw harness
freshness: monthly
last_reviewed: "2026-03-25"
title: Anthropic 长任务 Harness 对照清单
---

# Anthropic 长任务 Harness 对照清单

这份文档用来对照 Anthropic 文章
[Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
检查 OpenClaw 在长时间应用开发 harness 上的当前状态。

目标不是复述文章，而是把文章里的要求翻成 OpenClaw 当前的工程判断：

- 我们已经做到了什么
- 哪些只做到前置条件
- 哪些还没有正式落地
- 下一阶段最值得做的 P5 是什么

## 一句话结论

OpenClaw 现在已经有一套比较完整的 harness control plane：

- prompt budget
- task profile
- workspace policy discovery / slicing
- verify / failure / retry
- tool / skill pruning
- delegation profile
- health dashboard / doc gardening

但它还不是 Anthropic 文章里那种面向长时间应用开发的 `planner -> builder -> evaluator` build loop。

最明显的缺口不是更多 report，而是：

- planner artifact
- contract artifact
- builder / evaluator 角色分离
- richer evaluator pack
- browser / UI / app-state verification

## 状态定义

- `已满足`：已经形成正式能力，并有代码、测试或运行态证据
- `部分满足`：方向正确，已有控制面或前置能力，但还没有形成文章要求的完整环节
- `未满足`：文章要求对应的能力还没有正式落地
- `刻意暂缓`：不应现在就扩成更厚的通用编排框架

## 对照表

| 文章建议                                               | OpenClaw 当前状态                                                                                 | 状态       | 证据                                                                                                                 | 下一步                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 长任务要先解决 `context degradation / context anxiety` | 已有 prompt budget、policy discovery、policy slicing、dynamic pruning、retry / verify / dashboard | `部分满足` | `src/agents/system-prompt-report.ts`、`src/agents/workspace-health-dashboard.ts`、`/context list`、`/context health` | 增加真正的长任务 handoff artifact 与 compaction / reset 策略比较 |
| 不要让 generator 自评，要有独立 evaluator              | 已有 verify runner、structured failure、retry budget，但仍偏向单 run 的后置治理                   | `部分满足` | `src/agents/verify-report.ts`、`src/agents/failure-report.ts`、`src/agents/retry-report.ts`                          | 做真正的 `builder / evaluator` 角色分离                          |
| 对主观任务先定义可评分标准                             | 还没有正式 rubric artifact                                                                        | `未满足`   | 当前只有 verify / failure 报告                                                                                       | 增加 `acceptance.json` 和质量维度评分结构                        |
| evaluator 要看活的应用，而不是只看静态文本             | 还没有 browser / UI / app-state evaluator pack                                                    | `未满足`   | 当前 verify 主要是 `exec` 和 report-based                                                                            | 增加 browser-backed evaluator pack                               |
| planner 要把一句话 prompt 扩成完整 spec                | 还没有 planner 角色和 planner artifact                                                            | `未满足`   | 当前没有 planner 专属 artifact root                                                                                  | 增加 planner role preset 与 `spec.md` / `acceptance.json`        |
| generator 与 evaluator 先谈 contract 再开始做          | 还没有 contract artifact                                                                          | `未满足`   | 当前没有 build-run artifact contract                                                                                 | 增加 `acceptance.json`、`verify-pack.json`、`delegation.json`    |
| 长任务需要结构化 handoff artifact                      | 已有 roadmap、repo knowledge、session report，但还没有专门的 build-run artifact root              | `部分满足` | `docs/exec-plans/`、`docs/tech-debt/`、`/context` 系列报告                                                           | 建立 `.openclaw/build-runs/<run-id>/` artifact root 与 schema    |
| harness 复杂度要随着模型提升而下降                     | 已明确不做厚 DSL，也持续收敛 live heuristics                                                      | `部分满足` | `docs/concepts/harness-roadmap.md`、`docs/exec-plans/role-scoped-build-loop.md`                                      | 把 load-bearing 检查做成正式 benchmark / review 流程             |
| evaluator 是否值得，要看任务是否在模型能力边界附近     | 还没有 difficulty / boundary heuristic                                                            | `未满足`   | 当前没有 evaluator 启用策略                                                                                          | 增加 task difficulty / evaluator gating heuristic                |
| QA agent 默认不够苛刻，需要单独调教                    | 现在 failure / verify 是结构化的，但没有 evaluator 专属 prompt 校准                               | `未满足`   | 当前没有 evaluator calibration path                                                                                  | 增加 evaluator-specific prompt / few-shot / failure bias         |
| 结果要以真实使用路径为准                               | verify 已经真实化，但仍主要是命令型                                                               | `部分满足` | `/context` 中的 `Verify runner`、`Failure reason`                                                                    | 扩到 browser、logs、API、report、DB 等 richer checks             |
| 长任务质量提升来自规划 + 生成 + 外部质检闭环           | OpenClaw 现在更像强 control plane，还不是 role loop                                               | `部分满足` | `docs/exec-plans/role-scoped-build-loop.md`                                                                          | 落地 role-scoped build loop Phase 1                              |

## 当前最接近文章要求的部分

OpenClaw 已经具备这篇文章非常需要的基础底座：

- `更薄的上下文`
  - task profile
  - policy slicing
  - dynamic tool / skill pruning
- `更可信的结果判断`
  - verify runner
  - structured failure
  - retry budget
- `更强的运行可解释性`
  - `/context`
  - workspace health dashboard
  - delegation profile
- `更强的 repo knowledge`
  - docs index
  - exec plans
  - tech debt
  - doc gardening

这意味着 OpenClaw 不需要从零开始做 Anthropic 那种 loop。

真正缺的，是把已有 control plane 抬升成 `planner -> builder -> evaluator` 的任务级 recipe。

## 真正的差距

### 1. 缺 planner

OpenClaw 现在还没有一个把简短用户目标扩成完整 spec / acceptance / verify strategy 的正式 planner 角色。

### 2. 缺 contract artifact

当前 run 的 verify / failure / retry 都已经很强，但还没有一个能在 planner、builder、evaluator 三方之间稳定传递的合同式 artifact。

### 3. 缺 evaluator pack

现在 verify 更像“命令型真实验证”，还不像“QA 风格的外部质检”：

- browser
- screenshot
- logs
- API
- report
- DB / app-state

### 4. 缺 role-scoped build loop

现在虽然有 delegation profile，但还没有真正的：

- planner role preset
- builder role preset
- evaluator role preset
- build-run artifact root
- bounded build / evaluate loop

## P5：面向长时间应用开发的 role-scoped build loop

Anthropic 文章对 OpenClaw 最自然的下一阶段，不是再堆一层 report，而是把已有 harness core 提升成一条轻量的 role-scoped build loop。

这个 `P5` 不应该做成厚编排 DSL，而应该直接落在现有执行计划上：

- [Role-Scoped Build Loop](/exec-plans/role-scoped-build-loop)
- [Role-Scoped Build Loop Phase 1 Backlog](/exec-plans/role-scoped-build-loop-phase-1-backlog)

### P5 Todo

- [x] `roles/role-preset-schema`
  - 增加 `planner / builder / evaluator` 角色预设
- [x] `build-runs/artifact-root-and-schemas`
  - 建立稳定的 build-run artifact root 和最小 schema
- [x] `delegation/role-aware-spawn-defaults`
  - 让 spawn 默认按角色收紧工具面、验证姿态和 artifact 权限
- [ ] `verify/verify-pack-schema`
  - 建立 `verify-pack.json`，先支持 `exec / logs / report`
- [ ] `verify/browser-evaluator-pack`
  - 给 evaluator 增加 browser-backed richer checks
- [ ] `docs/manual-role-scoped-build-walkthrough`
  - 补一份人工可跟跑的 walkthrough，帮助调 prompt 和校 evaluator

### P5 验收信号

- 一个长时间 build 任务可以显式声明 `planner / builder / evaluator`
- planner 会输出稳定 artifact，而不是只在聊天里说计划
- builder 不再无限扩 scope，而是围绕 contract 和 verify intent 推进
- evaluator 能基于真实 check kind 拦下不达标结果
- 整个 loop 可以在不引入厚 DSL 的前提下运行和调试

### P5 当前进度

目前已经完成第一项 `roles/role-preset-schema`：

- `sessions_spawn` 可以声明 `rolePreset`
- runtime 会把它持久化到 child session
- `/context` 会显示 `preset / promptMode / toolBias / verificationPosture / artifactWriteScope`

目前也已经完成第二项 `build-runs/artifact-root-and-schemas`：

- repo workspace 会写到 `<repo>/.openclaw/build-runs/<run-id>/`
- 非 repo workspace 会写到 `~/.openclaw/build-runs/<workspace-slug>/<run-id>/`
- `acceptance.json`、`verify-pack.json`、`build-report.json`、`eval-report.json` 已有 schema-backed 读写助手
- workspace policy discovery 会显式跳过 `.openclaw/build-runs`

目前也已经完成第三项 `delegation/role-aware-spawn-defaults`：

- `planner / builder / evaluator` 会映射到真实默认工具面，而不是只停留在 session metadata
- `planner` 默认 read-heavy，`builder` 默认 edit/write/exec，`evaluator` 默认 read/exec/browser
- builder preset 会恢复标准 coding prompt，其它 build-loop 角色默认保持 minimal prompt
- `sessions_spawn` 新增 `buildRunId`，并且 child spawn 会自动继承 `buildRunId / buildRunDir`
- child system prompt 会拿到 role preset 和 artifact root 提示，知道该读/该写哪些 JSON artifact

下一步应该直接进入：

- `verify/verify-pack-schema`

## 建议的推进顺序

如果按 Anthropic 这篇文章来排 OpenClaw 的下一步，我建议是：

1. 先落地 `P5 Phase 1`
2. 再把 `P4` 里的 browser / observability surfaces 接成 evaluator pack
3. 最后才考虑更广的 UI / review / merge automation

这样做的原因是：

- role loop 才是下一阶段最大的质量杠杆
- browser / observability 只有接入 evaluator，收益才最直接
- 太早做更厚的 workflow surface，很容易重新走回重 orchestrator 的路

## 最后结论

如果按 Anthropic 文章的标准看，OpenClaw 现在已经具备了很强的 harness core，但还没有进入真正的 long-running app build harness 阶段。

`P5` 的意义，就是把这层差距显式化，并用最小、最薄、最可调试的方式，把 OpenClaw 推到下一阶段：

- 不是更厚的 prompt
- 不是更重的 orchestrator
- 而是更清晰的角色、artifact、contract 和 evaluator pack
