# 策略生成与 coding-agent 所需工具配置

使用 **Strategy Builder**（fin-strategy-builder）或 **coding-agent** 生成策略包、读写文件或执行命令时，Agent 必须拥有 **read**（读文件）和 **exec**（执行 shell 命令）等基础工具。这些工具由 OpenClaw 的 **工具 profile** 控制。

## 问题现象

若未配置为允许「编程类」工具，Agent 会提示例如：

- 「我没有 read 工具来读取 skill 文件」
- 「我没有 bash/exec 工具来运行命令」
- coding-agent 和 fin-strategy-builder 需要这些基础工具

## 原因说明

- **read**、**write**、**edit**、**exec**、**process** 等属于 **coding** profile。
- 默认或仅使用 **messaging** / **minimal** profile 时，这些工具会被过滤掉，导致无法读文件、写策略、执行打包命令等。

## 解决方法

在 OpenClaw 配置中启用 **coding** profile，或通过 **alsoAllow** 显式放开 read/exec。

### 使用 FinClaw Starter 模板（推荐）

若通过 `openclaw commons install finclaw-starter --dir <path>` 安装工作区模板，其 **openclaw.json** 已包含 `tools.profile: "coding"`，无需再改配置即可使用策略生成与 coding-agent。若仍报「没有 read/exec 工具」，请确认：1）当前运行使用的是该工作区下的 openclaw.json；2）全局或 Agent 级未把 profile 覆盖为 messaging。

### 方式一：全局使用 coding profile（推荐用于策略生成）

在 `openclaw.json`（或对应 config 根）中设置：

```json5
{
  tools: {
    profile: "coding",
  },
}
```

这样当前 Agent 会拥有 read、write、edit、exec、process 等工具，策略生成与 coding-agent 流程可正常进行。

### 方式二：保持 messaging，仅额外放开 read/exec

若希望默认仍是「仅消息类」工具，只给策略生成放行读文件与执行命令：

```json5
{
  tools: {
    profile: "messaging",
    alsoAllow: ["read", "exec", "write", "edit"],
  },
}
```

按需保留 `write`、`edit`（生成/修改策略文件时通常也需要）。

### 方式三：按 Agent 配置

若有多 Agent，只需为「负责策略生成」的 Agent 开放 coding 工具：

```json5
{
  tools: { profile: "messaging" },
  agents: {
    list: [
      {
        id: "main",
        tools: { profile: "coding" },
      },
    ],
  },
}
```

## 配置位置

- 全局：config 根下的 `tools.profile`、`tools.alsoAllow`。
- 单 Agent：`agents.list[].tools.profile`、`agents.list[].tools.alsoAllow`。
- 配置文件通常为工作区或默认 config 路径下的 `openclaw.json`（或项目约定的 config 文件名）。

修改后需重启或重新加载 Agent/Gateway 使配置生效。

## 无需子代理（sessions_spawn）的测试方式

策略相关流程**不依赖子代理**。生成策略包、校验、打包、提交回测等都可以在**当前会话**内完成，Agent 使用 **read / write / edit / exec** 即可，无需 `sessions_spawn` 权限。

### 适用场景

- 没有「创建策略子代理」权限（例如 `sessions_spawn` 被禁用或未配置 `agents.*.subagents.allowAgents`）。
- 希望在本机或当前会话内直接验证策略生成与回测提交流程。

### 推荐测试步骤

1. **配置**：在当前工作区的 `openclaw.json` 中设置 `tools.profile: "coding"`（或按上文「方式二」用 `alsoAllow` 放开 read/exec/write/edit），确保**主 Agent** 具备读文件、写文件、执行命令的能力。
2. **运行主 Agent**：
   - **CLI**：在工作区目录执行 `pnpm openclaw agent` 或 `openclaw agent`，进入对话后直接说「帮我创建一个简单的定投策略」或「根据当前目录生成一个 FEP 策略包」。
   - **Gateway 对话**：若通过 Telegram/Discord 等接入，确保该通道使用的 config 同样包含 `tools.profile: "coding"`，在同一对话里直接请求创建策略即可。
3. **流程**：Agent 会在当前会话内用 `read`/`write`/`edit` 生成 `fep.yaml`、`scripts/strategy.py`，用 `exec` 执行打包或校验命令（若已安装 fin-backtest-remote，可调用 `backtest_remote_validate` 等）。全程无需调用 `sessions_spawn`。

### 小结

| 能力               | 是否需要子代理               |
| ------------------ | ---------------------------- |
| 策略生成与校验     | 否，主会话即可               |
| 打包 ZIP、提交回测 | 否，主会话 + exec / 插件工具 |
| 后台并行、独立会话 | 是，需 `sessions_spawn` 权限 |

若当前环境不允许使用 `sessions_spawn`，可完全依赖主 Agent + coding profile 正常测试策略相关流程。

## 参考

- **对话中同时使用策略构建与远程回测**：见 [对话中使用策略构建与远程回测 — 配置说明](./conversation-strategy-backtest-config.md)。
- 工具与 profile 说明：[Tools (OpenClaw)](/tools) — `tools.profile`、`tools.allow`/`deny`、`tools.alsoAllow`。
- 策略包结构：见 [回测Server-fep-v1.1使用指南](./回测Server-fep-v1.1使用指南.md)。
