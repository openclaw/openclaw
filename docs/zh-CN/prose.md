---
read_when:
  - 你想运行或编写 .prose 工作流
  - 你想启用 OpenProse 插件
  - 你需要了解状态存储
summary: OpenProse：OpenClaw 中的 .prose 工作流、斜杠命令和状态管理
title: OpenProse
x-i18n:
  generated_at: "2026-02-01T21:34:47Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: cf7301e927b9a46347b498e264aeaa10dd76e85ff2de04775be57435718339f5
  source_path: prose.md
  workflow: 15
---

# OpenProse

OpenProse 是一种可移植的、以 Markdown 为核心的工作流格式，用于编排 AI 会话。在 OpenClaw 中，它以插件形式提供，安装后包含一个 OpenProse Skills 包和一个 `/prose` 斜杠命令。程序存放在 `.prose` 文件中，可以通过显式控制流生成多个子智能体。

官方网站：https://www.prose.md

## 功能概述

- 支持显式并行的多智能体研究与综合。
- 可重复的、审批安全的工作流（代码审查、事件分诊、内容流水线）。
- 可复用的 `.prose` 程序，可在支持的智能体运行时中运行。

## 安装与启用

内置插件默认处于禁用状态。启用 OpenProse：

```bash
openclaw plugins enable open-prose
```

启用插件后重启 Gateway网关。

开发/本地签出：`openclaw plugins install ./extensions/open-prose`

相关文档：[插件](/plugin)、[插件清单](/plugins/manifest)、[Skills](/tools/skills)。

## 斜杠命令

OpenProse 注册 `/prose` 作为用户可调用的 Skills 命令。它路由到 OpenProse 虚拟机指令，底层使用 OpenClaw 工具。

常用命令：

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## 示例：一个简单的 `.prose` 文件

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## 文件位置

OpenProse 将状态保存在工作区的 `.prose/` 目录下：

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

用户级别的持久化智能体存放在：

```
~/.prose/agents/
```

## 状态模式

OpenProse 支持多种状态后端：

- **filesystem**（默认）：`.prose/runs/...`
- **in-context**：瞬态，适用于小型程序
- **sqlite**（实验性）：需要 `sqlite3` 二进制文件
- **postgres**（实验性）：需要 `psql` 和连接字符串

注意事项：

- sqlite/postgres 为可选启用，属于实验性功能。
- postgres 凭据会流入子智能体日志；请使用专用的最小权限数据库。

## 远程程序

`/prose run <handle/slug>` 解析为 `https://p.prose.md/<handle>/<slug>`。
直接 URL 按原样获取。此功能使用 `web_fetch` 工具（POST 请求使用 `exec`）。

## OpenClaw 运行时映射

OpenProse 程序映射到 OpenClaw 原语：

| OpenProse 概念       | OpenClaw 工具    |
| -------------------- | ---------------- |
| 生成会话 / Task 工具 | `sessions_spawn` |
| 文件读写             | `read` / `write` |
| Web 获取             | `web_fetch`      |

如果你的工具允许列表阻止了这些工具，OpenProse 程序将无法运行。参阅[Skills配置](/tools/skills-config)。

## 安全与审批

请像对待代码一样对待 `.prose` 文件。运行前请先审查。使用 OpenClaw 工具允许列表和审批门控来控制副作用。

如需确定性的、带审批门控的工作流，可参考 [Lobster](/tools/lobster) 进行比较。
