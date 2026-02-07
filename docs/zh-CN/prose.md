---
read_when:
  - 你想运行或编写 .prose 工作流
  - 你想启用 OpenProse 插件
  - 你需要了解状态存储
summary: OpenProse：OpenClaw 中的 .prose 工作流、斜杠命令和状态
title: OpenProse
x-i18n:
  generated_at: "2026-02-03T07:53:38Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: cf7301e927b9a46347b498e264aeaa10dd76e85ff2de04775be57435718339f5
  source_path: prose.md
  workflow: 15
---

# OpenProse

OpenProse 是一种可移植的、以 Markdown 为中心的工作流格式，用于编排 AI 会话。在 OpenClaw 中，它作为插件发布，安装一个 OpenProse Skills 包以及一个 `/prose` 斜杠命令。程序存放在 `.prose` 文件中，可以生成多个具有显式控制流的子智能体。

官方网站：https://www.prose.md

## 它能做什么

- 具有显式并行性的多智能体研究 + 综合。
- 可重复的批准安全工作流（代码审查、事件分类、内容管道）。
- 可在支持的智能体运行时之间运行的可重用 `.prose` 程序。

## 安装 + 启用

捆绑的插件默认是禁用的。启用 OpenProse：

```bash
openclaw plugins enable open-prose
```

启用插件后重启 Gateway 网关。

开发/本地检出：`openclaw plugins install ./extensions/open-prose`

相关文档：[插件](/plugin)、[插件清单](/plugins/manifest)、[Skills](/tools/skills)。

## 斜杠命令

OpenProse 将 `/prose` 注册为用户可调用的 Skills 命令。它路由到 OpenProse VM 指令，并在底层使用 OpenClaw 工具。

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

OpenProse 将状态保存在工作空间的 `.prose/` 下：

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

用户级持久智能体位于：

```
~/.prose/agents/
```

## 状态模式

OpenProse 支持多种状态后端：

- **filesystem**（默认）：`.prose/runs/...`
- **in-context**：瞬态，用于小程序
- **sqlite**（实验性）：需要 `sqlite3` 二进制文件
- **postgres**（实验性）：需要 `psql` 和连接字符串

说明：

- sqlite/postgres 是选择加入的，且处于实验阶段。
- postgres 凭证会流入子智能体日志；请使用专用的、最小权限的数据库。

## 远程程序

`/prose run <handle/slug>` 解析为 `https://p.prose.md/<handle>/<slug>`。
直接 URL 按原样获取。这使用 `web_fetch` 工具（或用于 POST 的 `exec`）。

## OpenClaw 运行时映射

OpenProse 程序映射到 OpenClaw 原语：

| OpenProse 概念       | OpenClaw 工具    |
| -------------------- | ---------------- |
| 生成会话 / Task 工具 | `sessions_spawn` |
| 文件读/写            | `read` / `write` |
| Web 获取             | `web_fetch`      |

如果你的工具白名单阻止这些工具，OpenProse 程序将失败。参见 [Skills 配置](/tools/skills-config)。

## 安全 + 批准

将 `.prose` 文件视为代码。运行前请审查。使用 OpenClaw 工具白名单和批准门控来控制副作用。

对于确定性的、批准门控的工作流，可与 [Lobster](/tools/lobster) 比较。
