---
summary: "OpenProse：OpenClaw 中的 .prose 工作流程、斜線指令和狀態"
read_when:
  - 您想執行或編寫 .prose 工作流程
  - 您想啟用 OpenProse 外掛程式
  - 您需要了解狀態儲存
title: "OpenProse"
---

# OpenProse

OpenProse 是一種可攜式、Markdown 優先的工作流程格式，用於協調 AI 工作階段。在 OpenClaw 中，它以一個外掛程式的形式發佈，該外掛程式會安裝一個 OpenProse Skills 包以及一個 `/prose` 斜線指令。程式碼位於 `.prose` 檔案中，可以產生多個具有明確控制流程的子智慧代理。

官方網站：[https://www.prose.md](https://www.prose.md)

## 功能

-   透過明確的平行處理，進行多智慧代理研究與綜合。
-   可重複、核准安全的流程（程式碼審查、事件分類、內容管道）。
-   可跨支援的智慧代理運行時重複使用的 `.prose` 程式。

## 安裝與啟用

捆綁的外掛程式預設為停用。啟用 OpenProse：

```bash
openclaw plugins enable open-prose
```

啟用外掛程式後請重新啟動 Gateway。

開發/本地檢查：`openclaw plugins install ./extensions/open-prose`

相關文件：[外掛程式](/tools/plugin)、[外掛程式清單](/plugins/manifest)、[Skills](/tools/skills)。

## 斜線指令

OpenProse 會註冊 `/prose` 作為使用者可叫用的 Skills 指令。它會路由到 OpenProse VM 指令，並在底層使用 OpenClaw 工具。

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

OpenProse 將狀態儲存在您工作區的 `.prose/` 下：

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

使用者層級的持久智慧代理位於：

```
~/.prose/agents/
```

## 狀態模式

OpenProse 支援多種狀態後端：

-   **檔案系統** (預設)：`.prose/runs/...`
-   **上下文內**：暫時的，適用於小型程式
-   **sqlite** (實驗性)：需要 `sqlite3` 二進位檔案
-   **postgres** (實驗性)：需要 `psql` 和連線字串

注意事項：

-   sqlite/postgres 是選擇性加入且為實驗性功能。
-   postgres 憑證會流入子智慧代理日誌；請使用專用且權限最低的資料庫。

## 遠端程式

`/prose run <handle/slug>` 會解析為 `https://p.prose.md/<handle>/<slug>`。
直接的 URL 會照原樣擷取。這使用 `web_fetch` 工具 (或 POST 的 `exec`)。

## OpenClaw 運行時映射

OpenProse 程式會映射到 OpenClaw 原語：

| OpenProse 概念            | OpenClaw 工具    |
| :------------------------ | :--------------- |
| 產生工作階段 / 任務工具 | `sessions_spawn` |
| 檔案讀取/寫入             | `read` / `write` |
| 網路擷取                  | `web_fetch`      |

如果您的工具允許清單阻擋了這些工具，OpenProse 程式將會失敗。請參閱 [Skills 設定](/tools/skills-config)。

## 安全性與核准

將 `.prose` 檔案視為程式碼。執行前請先審查。使用 OpenClaw 工具允許清單和核准閘道來控制副作用。

對於確定性、核准門控的工作流程，請與 [Lobster](/tools/lobster) 比較。
