---
summary: "OpenProse: OpenClaw 中的 .prose 工作流、斜杠命令和状态"
read_when:
  - 你想运行或编写 .prose 工作流
  - 你想启用 OpenProse 插件
  - 你需要了解状态存储
title: "OpenProse"
---

# OpenProse

OpenProse 是一种便携式、以 Markdown 为先的工作流格式，用于编排 AI 会话。在 OpenClaw 中，它作为插件提供，安装 OpenProse 技能包和 `/prose` 斜杠命令。程序存储在 `.prose` 文件中，可以通过显式控制流生成多个子代理。

官方网站：[https://www.prose.md](https://www.prose.md)

## 它能做什么

- 具有显式并行性的多代理研究 + 综合。
- 可重复的审批安全工作流（代码审查、事件分类、内容管道）。
- 可重用的 `.prose` 程序，你可以在支持的代理运行时中运行。

## 安装 + 启用

捆绑插件默认是禁用的。启用 OpenProse：

```bash
openclaw plugins enable open-prose
```

启用插件后重启网关。

开发/本地检出：`openclaw plugins install ./path/to/local/open-prose-plugin`

相关文档：[插件](/tools/plugin)、[插件清单](/plugins/manifest)、[技能](/tools/skills)。

## 斜杠命令

OpenProse 注册 `/prose` 作为用户可调用的技能命令。它路由到 OpenProse VM 指令并在底层使用 OpenClaw 工具。

常见命令：

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
# 两个代理并行运行的研究 + 综合。

input topic: "我们应该研究什么？"

agent researcher:
  model: sonnet
  prompt: "你进行彻底研究并引用来源。"

agent writer:
  model: opus
  prompt: "你写一个简洁的摘要。"

parallel:
  findings = session: researcher
    prompt: "研究 {topic}。"
  draft = session: writer
    prompt: "总结 {topic}。"

session "将研究结果 + 草稿合并为最终答案。"
context: { findings, draft }
```

## 文件位置

OpenProse 在工作区的 `.prose/` 下保留状态：

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

用户级持久代理位于：

```
~/.prose/agents/
```

## 状态模式

OpenProse 支持多种状态后端：

- **filesystem**（默认）：`.prose/runs/...`
- **in-context**：瞬态，用于小程序
- **sqlite**（实验性）：需要 `sqlite3` 二进制文件
- **postgres**（实验性）：需要 `psql` 和连接字符串

注意：

- sqlite/postgres 是可选的且实验性的。
- postgres 凭据会流入子代理日志；请使用专用的、权限最小的数据库。

## 远程程序

`/prose run <handle/slug>` 解析为 `https://p.prose.md/<handle>/<slug>`。
直接 URL 按原样获取。这使用 `web_fetch` 工具（或 `exec` 用于 POST）。

## OpenClaw 运行时映射

OpenProse 程序映射到 OpenClaw 原语：

| OpenProse 概念 | OpenClaw 工具 |
| --- | --- |
| 生成会话 / 任务工具 | `sessions_spawn` |
| 文件读/写 | `read` / `write` |
| Web 获取 | `web_fetch` |

如果你的工具允许列表阻止这些工具，OpenProse 程序将失败。请参阅 [技能配置](/tools/skills-config)。

## 安全性 + 审批

将 `.prose` 文件视为代码。运行前进行审查。使用 OpenClaw 工具允许列表和审批门来控制副作用。

对于确定性的、审批门控的工作流，请与 [Lobster](/tools/lobster) 进行比较。