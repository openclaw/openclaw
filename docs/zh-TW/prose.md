---
summary: "OpenProse：OpenClaw 中的 .prose 工作流程、斜線指令與狀態"
read_when:
  - 你想要執行或撰寫 .prose 工作流程
  - 你想要啟用 OpenProse 外掛
  - 你需要了解狀態儲存
title: "OpenProse"
---

# OpenProse

OpenProse is a portable, markdown-first workflow format for orchestrating AI sessions. 在 OpenClaw 中，它以外掛形式提供，會安裝一個 OpenProse 技能套件以及一個 `/prose` 斜線指令。 程式存在於 `.prose` 檔案中，並可透過明確的控制流程產生多個子代理。

官方網站：[https://www.prose.md](https://www.prose.md)

## 它能做什麼

- 具備明確平行化的多代理研究與綜合。
- Repeatable approval-safe workflows (code review, incident triage, content pipelines).
- 可重用的 `.prose` 程式，可在支援的代理執行環境間執行。

## 安裝與啟用

Bundled plugins are disabled by default. Enable OpenProse:

```bash
openclaw plugins enable open-prose
```

Restart the Gateway after enabling the plugin.

開發／本機檢出：`openclaw plugins install ./extensions/open-prose`

相關文件：[Plugins](/tools/plugin)、[Plugin manifest](/plugins/manifest)、[Skills](/tools/skills)。

## 斜線指令

OpenProse registers `/prose` as a user-invocable skill command. OpenProse 會註冊 `/prose` 作為可由使用者呼叫的 Skills 指令。它會路由至 OpenProse VM 指令，並在底層使用 OpenClaw 工具。

常用指令：

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## 範例：一個簡單的 `.prose` 檔案

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

## 檔案位置

OpenProse 會將狀態儲存在你工作區中的 `.prose/` 之下：

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

使用者層級的持久代理程式位於：

```
~/.prose/agents/
```

## 狀態模式

OpenProse 支援多種狀態後端：

- **filesystem**（預設）：`.prose/runs/...`
- **in-context**：暫時性，適合小型程式
- **sqlite**（實驗性）：需要 `sqlite3` 二進位檔
- **postgres**（實驗性）：需要 `psql` 與連線字串

注意事項：

- sqlite／postgres 為選用且屬於實驗性。
- postgres 憑證會流入子代理的日誌；請使用專用且最小權限的資料庫。

## 遠端程式

`/prose run <handle/slug>` 會解析為 `https://p.prose.md/<handle>/<slug>`。
直接 URL 會原樣擷取。這會使用 `web_fetch` 工具（或對於 POST 使用 `exec`）。
Direct URLs are fetched as-is. This uses the `web_fetch` tool (or `exec` for POST).

## OpenClaw 執行環境對應

OpenProse 程式會對應到 OpenClaw 的基元：

| OpenProse 概念   | OpenClaw 工具      |
| -------------- | ---------------- |
| 產生工作階段／Task 工具 | `sessions_spawn` |
| 檔案讀取／寫入        | `read` / `write` |
| Web 擷取         | `web_fetch`      |

若你的工具允許清單封鎖了這些工具，OpenProse 程式將會失敗。請參閱 [Skills 設定](/tools/skills-config)。 See [Skills config](/tools/skills-config).

## 安全性與核准

Treat `.prose` files like code. Review before running. Use OpenClaw tool allowlists and approval gates to control side effects.

若需具備決定性、以核准為閘的工作流程，請與 [Lobster](/tools/lobster) 比較。
