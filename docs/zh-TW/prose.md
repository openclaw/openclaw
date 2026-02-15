---
summary: "OpenProse：.prose 工作流程、斜線指令與 OpenClaw 中的狀態"
read_when:
  - 您想要執行或編寫 .prose 工作流程
  - 您想要啟用 OpenProse 外掛
  - 您需要瞭解狀態儲存
title: "OpenProse"
---

# OpenProse

OpenProse 是一種可移植、Markdown 優先的工作流程格式，用於協調 AI 工作階段。在 OpenClaw 中，它以外掛形式提供，會安裝 OpenProse Skills 套件以及 `/prose` 斜線指令。程式儲存在 `.prose` 檔案中，並可以透過顯式控制流程產生多個子智慧代理。

官方網站：[https://www.prose.md](https://www.prose.md)

## 功能

- 具備顯式平行處理的多智慧代理研究與綜合。
- 可重複且核准安全的工作流程（程式碼審查、事件分類、內容流水線）。
- 可在支援的智慧代理執行階段中執行的重複使用 `.prose` 程式。

## 安裝 + 啟用

內建外掛預設為停用。啟用 OpenProse：

```bash
openclaw plugins enable open-prose
```

啟用外掛後請重新啟動 Gateway。

開發/本地檢出：`openclaw plugins install ./extensions/open-prose`

相關文件：[外掛](/tools/plugin), [外掛清單](/plugins/manifest), [Skills](/tools/skills)。

## 斜線指令

OpenProse 將 `/prose` 註冊為使用者可呼叫的 Skills 指令。它會導向 OpenProse VM 指令，並在底層使用 OpenClaw 工具。

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

OpenProse 在工作區的 `.prose/` 下儲存狀態：

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

使用者層級的持久性智慧代理儲存於：

```
~/.prose/agents/
```

## 狀態模式

OpenProse 支援多種狀態後端：

- **filesystem** (預設)：`.prose/runs/...`
- **in-context**：瞬態，適用於小型程式
- **sqlite** (實驗性)：需要 `sqlite3` 二進位檔
- **postgres** (實驗性)：需要 `psql` 和連線字串

注意：

- sqlite/postgres 為選用且具實驗性。
- postgres 憑證會流向子智慧代理紀錄；請使用專用的最小權限資料庫。

## 遠端程式

`/prose run <handle/slug>` 會解析為 `https://p.prose.md/<handle>/<slug>`。
直接 URL 會依原樣擷取。這使用 `web_fetch` 工具（或用於 POST 的 `exec`）。

## OpenClaw 執行階段對應

OpenProse 程式對應到 OpenClaw 基本元件：

| OpenProse 概念           | OpenClaw 工具    |
| ------------------------ | ---------------- |
| 產生工作階段 / Task 工具 | `sessions_spawn` |
| 檔案 讀取/寫入           | `read` / `write` |
| Web 擷取                 | `web_fetch`      |

如果您的工具允許清單封鎖了這些工具，OpenProse 程式將會失敗。請參閱 [Skills 設定](/tools/skills-config)。

## 安全性 + 核准

請像對待程式碼一樣對待 `.prose` 檔案。執行前請先審查。使用 OpenClaw 工具允許清單和核准閘門來控制副作用。

對於決定性的、受核准管制的工作流程，請與 [Lobster](/tools/lobster) 進行比較。
