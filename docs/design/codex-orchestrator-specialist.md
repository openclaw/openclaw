# Codex Orchestrator-Specialist Design

## Background

OpenClaw deployments often ask one primary agent to do too many jobs at once:
hold the user conversation, maintain long session context, call local tools,
read and write external documents, and perform higher-effort analysis or
writing when needed. As task complexity grows, a single agent handling both
orchestration and deep reasoning starts to show two problems.

First, the main conversation gets crowded out by long reasoning chains.
Technical research, architecture review, long-form writing, and multi-file code
understanding all require larger context windows and heavier thinking budgets.
If all of that stays on `main`, the primary session becomes slower and harder to
manage.

Second, delivery actions and specialist reasoning become mixed together.
Message sending, document writes, permission changes, and task closeout all
have clear external side effects. Codex is a better fit for high-density
analysis with fewer external side effects. Splitting the two roles improves
control, stability, and maintainability.

The design proposed here is therefore a simple two-layer structure: `main` as
orchestrator, and `codex` as specialist.

## Goals

The goal is not to turn Codex into a second peer chatbot. The goal is to make
Codex an internal specialist capability that OpenClaw can schedule when needed.

The concrete goals are:

- 对用户保持单入口。用户继续只和 `main` 交互，不需要理解内部 agent 拓扑。
- 把高复杂度分析任务下沉给 Codex，减轻 `main` 的推理负担。
- 保持外部副作用集中在 `main`。例如 Feishu 发消息、建文档、改权限等动作，默认仍由 `main` 收口执行。
- 为后续扩展更多 specialist 打基础，例如 `claude`、`gemini`、`kimi` 等。

## Role Split

### Main as Orchestrator

`main` 负责用户界面的连续性与执行流程的完整性。它的核心职责包括：

- 接收用户请求并判断意图。
- 决定任务是否需要调用 specialist。
- 为 specialist 组织足够但不过量的上下文。
- 回收 specialist 的结果并做二次整理。
- 执行最终交付动作，例如生成飞书文档、发送消息、调用权限工具、记录结果。

换句话说，`main` 不一定是最擅长深度研究的 agent，但它必须是最擅长“把事情做完”的 agent。

### Codex as Specialist

`codex` 负责高思考密度工作，重点在分析、推理、提炼和草稿输出，而不是直接面对用户或直接控制外部渠道。

适合交给 Codex 的任务包括：

- 代码库深度理解与架构解读
- 技术方案比较与调研
- 较长篇幅的技术写作初稿
- 复杂问题的根因分析
- 多文件、多模块的实现路径梳理

Codex 的输出应尽量是“可回收”的中间成果，例如报告草稿、结构化分析、风险清单、候选方案，而不是直接代替 `main` 做最终交付。

## Interaction Model

推荐的标准链路是：

1. 用户把需求发给 `main`
2. `main` 判断这是否是高复杂度任务
3. 若是，则通过 ACP runtime 拉起或复用 `codex`
4. `main` 向 `codex` 提供任务描述、目标输出格式、必要上下文
5. `codex` 完成分析并返回结果
6. `main` 对结果做筛选、压缩、整理和执行收口动作
7. `main` 向用户交付最终结果

这里最重要的是第 4 步和第 6 步。`main` 不能把一个模糊请求原封不动扔给 Codex，也不能把 Codex 的原始输出不加处理地回给用户。它更像项目经理和编辑，而 Codex 更像研究员和撰稿人。

## Trigger Rules

为了避免过度调度，`main` 需要有清晰的触发规则。建议将任务分成三类。

第一类，直接由 `main` 完成：

- 简单问答
- 轻量级总结
- 已有工具即可快速完成的操作
- 明显是飞书工具编排的问题，例如改文档权限、读写文档、查状态

第二类，优先交给 `codex`：

- 用户明确点名“调用 Codex”
- 需要 1000 字以上的系统性技术写作
- 需要读取代码库后给出分析
- 需要比较多个方案并说明取舍
- 需要较强结构化输出的研究型任务

第三类，混合执行：

- 先由 Codex 形成研究结果，再由 `main` 创建飞书文档
- 先由 Codex 产出方案，再由 `main` 调用工具验证或落地
- 先由 Codex 写长文初稿，再由 `main` 改写成适合用户渠道的版本

## Runtime Recommendation

从当前 OpenClaw 能力和代码结构看，Codex 更适合作为 ACP harness 接入，而不是普通 subagent。

原因有三点：

- 从语义上，Codex 更像外部专家运行时，而不是 OpenClaw 内部原生 agent。
- 仓库已有的 ACP 文档、测试和 `acpx` 插件，已经为这一模式提供了基础设施。
- 后续接入更多 specialist 时，ACP 模型更统一，不必把每个外部能力都伪装成内部 agent。

因此推荐的运行模型是：

- `main` 保持当前主 agent 身份
- `codex` 在 `agents.list` 中声明为 `runtime.type = "acp"`
- 全局启用 `acp` 与 `acpx`
- `main` 在需要时通过 `sessions_spawn(runtime="acp", agentId="codex")` 调用 Codex

## Minimal Viable Configuration

为了让这套结构真正跑起来，最小配置闭环需要补齐四层。

第一层是插件层。当前环境里如果没有启用 `acpx`，即使本机已经安装并登录 Codex，OpenClaw 也没有 ACP backend 可以调用。因此需要保证插件白名单中包含 `acpx`，并显式启用它。

第二层是全局 ACP 层。建议设置：

- `acp.enabled = true`
- `acp.backend = "acpx"`
- `acp.defaultAgent = "codex"`
- `acp.allowedAgents` 至少包含 `codex`

这层配置的价值在于，OpenClaw 会明确知道“Codex 是一个可用的 ACP harness 目标”，而不是让主会话去猜测。

第三层是 agent 拓扑层。当前若只有 `agents.defaults` 而没有 `agents.list`，OpenClaw 很难稳定表达“谁是主 agent，谁是 specialist”。因此建议至少显式定义两个 agent：

- `main`
- `codex`

其中 `codex` 需要声明为 ACP runtime，语义上相当于“这是一个通过 ACP backend 调用的专家运行时”，而不是普通的 OpenClaw 原生 agent。

第四层是调用层。建议一开始不要做复杂绑定，而是先让 `main` 在需要时显式调用：

- `sessions_spawn`
- `runtime = "acp"`
- `agentId = "codex"`

这样可以先把主流程打通，再逐步优化触发规则和绑定策略。

如果用配置片段描述，目标形态大致如下：

```json5
{
  plugins: {
    allow: ["feishu", "memory-core", "phone-control", "talk-voice", "acpx"],
    entries: {
      acpx: {
        enabled: true,
      },
    },
  },
  acp: {
    enabled: true,
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: ["codex"],
  },
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.4-mini",
      },
    },
    list: [
      {
        id: "main",
        default: true,
      },
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/path/to/openclaw-workspace",
          },
        },
      },
    ],
  },
}
```

There are three practical rollout recommendations here.

First, start with `mode: "persistent"` if the common pattern is research,
iteration, refinement, and follow-up. Persistent sessions fit that rhythm
better than one-shot execution.

Second, make `cwd` point to the intended workspace explicitly. Otherwise Codex
may start in the wrong directory and lose important local context.

Third, do not bind many user entry points directly to `codex` on day one. Let
`main` remain the single public entry point, stabilize the internal call path,
and only then decide whether stronger automatic routing is worthwhile.

## Rollout Plan

建议按低风险顺序推进，而不是一次性把所有功能都接上。

阶段一，先打通运行时：

- 启用 `acpx`
- 配置全局 `acp`
- 显式声明 `main` 和 `codex`
- 重启 OpenClaw

阶段二，做最小验证：

- 在 Feishu 中发一个明确要求“调用 Codex”的轻量调研任务
- 观察是否成功创建或复用 ACP session
- 确认 `main` 能回收到 Codex 的结果并正常回复

阶段三，再验证完整业务闭环：

- `main` 调 Codex 做研究
- `main` 整理结果
- `main` 创建飞书文档并做检查

阶段四，最后再优化触发逻辑：

- 哪些场景自动调用 Codex
- 哪些任务只由 `main` 自己处理
- 是否要加更多 specialist

## Why Not Start With Subagents

It is possible to model `codex` as a regular subagent first and allow calls via
something like `main.subagents.allowAgents = ["codex"]`. That can work as a
compatibility path, but it is not the preferred long-term design.

Subagent semantics are better suited to collaboration between OpenClaw-native
agents, while Codex behaves more like an external specialist runtime. If Codex
is modeled as a subagent from the start, later specialist integrations such as
Claude, Gemini, or other ACP targets become harder to reason about because
internal agents and external harnesses get mixed together.

Subagents can therefore be a short-term fallback, but they should not be the
main design center for this architecture.

## Context Packaging

这套设计成败很大程度取决于 `main` 如何打包上下文。

建议 `main` 给 Codex 的输入始终包含四部分：

- 任务目标：要解决什么问题
- 输出要求：希望返回什么形式的结果
- 上下文摘要：必要代码位置、历史结论、外部约束
- 行为边界：是否允许改代码、是否允许联网、是否只做研究

这样能显著减少 Codex 在上下文上“找方向”的消耗，也能让回收结果更稳定。

## Output Contract

为了让 `main` 更容易消费 Codex 的结果，建议逐步形成统一输出约定。即使不是严格 JSON，也应尽量结构化，例如：

- 结论
- 关键依据
- 风险与不确定性
- 建议下一步
- 如需交付文档时，再给一个可直接整理的正文草稿

这能帮助 `main` 在后处理时更稳定地抽取重点，而不是每次都重新理解一篇长文。

## Risks

这套设计的主要风险有四类。

第一，调度过度。若 `main` 把太多轻任务都丢给 Codex，会增加时延和复杂性。

第二，职责漂移。若 Codex 直接承担越来越多外部动作，最终会和 `main` 角色重叠，失去边界。

第三，上下文污染。若持久 ACP 会话没有良好重置策略，长时间累积后结果会逐渐失真。

第四，配置复杂度。ACP、`acpx`、agent runtime、权限策略需要成体系配置，否则会出现“本机 Codex 在，但 OpenClaw 调不起来”的问题。

## Suggested Next Step

下一步不建议先做大量代码改造，而是按最小闭环推进：

- 配置 `acpx` 插件
- 打开全局 `acp` 配置
- 增加 `agents.list` 中的 `main` 与 `codex`
- 先打通一个最小任务闭环：`main` 调 Codex 做调研，`main` 回收结果并写入飞书文档

只要这个闭环稳定，再考虑增加更细的触发规则、结果模板和 specialist 池扩展。

## Summary

`main orchestrator + codex specialist` is not just "one more agent". It is a
way to layer OpenClaw's execution model: `main` owns user continuity and
external side effects, while Codex owns higher-complexity analysis and draft
generation. That split fits current specialist use cases and also scales more
naturally toward a broader multi-specialist system.
