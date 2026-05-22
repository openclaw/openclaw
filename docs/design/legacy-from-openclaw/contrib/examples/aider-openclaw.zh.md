# Aider 与 OpenClaw：是否作为「专用编程 agent」

## 是否合理

- **部分合理，但不宜与 OpenClaw 内置能力简单等同**。OpenClaw 已经通过 **Codex 相关能力、ACP（Agent Client Protocol）** 等路线支持「在仓库里改代码」类工作流；**Aider** 则是另一套以终端/CLI 为中心的 pair-programming 体验， strengths 在 **独立 repo 会话、明确 patch 流、与本地 git 工作流惯用者契合**。
- **把 Aider 做成 OpenClaw 唯一/官方「专用编程 agent」** 通常**不划算**：产品面与 **Codex/ACP** 重叠，维护两套「一等公民」编程循环成本高；更符合仓库架构的做法是 **一种主路径 + 文档化衔接**，除非未来有独立的 **`extensions/aider`** 类插件与明确维护承诺。

## 推荐用法（不新增核心扩展时）

1. **主路径**：在 OpenClaw 内用已有 **编程/会话** 能力处理日常改库需求。
2. **需要 Aider 时**：在**目标仓库**里单独开 **Aider 终端会话**（或 tmux pane），与 **OpenClaw Gateway** 并行；由你在对话里 **复制上下文/任务说明** 到 Aider，或反过来把 Aider 产出的 diff 交给 OpenClaw 审核。
3. **自动化衔接**（进阶）：若 Aider 或包装器暴露 **MCP** 或稳定 **HTTP API**，可在 **`openclaw.json` 的 `mcp.servers`** 中接入；**不要**默认让 Gateway **无鉴权执行 `aider` 子进程**（安全与沙箱策略需单独设计）。

## 若要在仓库内「扩展」

- **`contrib`/文档与示例 Skill**：说明绑定策略、风险提示、与 **`exec` 工具的边界**——这是低成本、合规的增量。
- **正式「OpenClaw 里的 Aider 插件」**：属于 **`extensions/`** 下新插件，需 manifest、配置契约与测试；超出本文档范围，且应经维护者评审后再做。

## 与本仓库已有路径的关系

- 配置与网关规则仍以根目录 **`AGENTS.md`**、`extensions/*/AGENTS.md` 为准；**contrib** 内容为社区/运维示例，**非**产品默认行为。
