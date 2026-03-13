---
summary: "OpenProse: .prose workflows, slash commands, and state in OpenClaw"
read_when:
  - You want to run or write .prose workflows
  - You want to enable the OpenProse plugin
  - You need to understand state storage
title: OpenProse
---

# OpenProse

OpenProse 是一個可攜式、以 Markdown 為主的工作流程格式，用於協調 AI 會話。在 OpenClaw 中，它以插件形式提供，安裝時會包含一組 OpenProse 技能包以及一個 `/prose` 斜線指令。程式存放於 `.prose` 檔案中，並能啟動多個子代理，具備明確的控制流程。

官方網站：[https://www.prose.md](https://www.prose.md)

## 功能介紹

- 多代理研究與綜合，支援明確的平行處理。
- 可重複執行且安全的審核流程（程式碼審查、事件分流、內容管線）。
- 可重複使用的 `.prose` 程式，可在支援的代理執行環境中執行。

## 安裝與啟用

預設情況下，內建插件為停用狀態。啟用 OpenProse：

```bash
openclaw plugins enable open-prose
```

啟用插件後，請重新啟動 Gateway。

開發/本地檢出：`openclaw plugins install ./extensions/open-prose`

相關文件：[插件](/tools/plugin)、[插件清單](/plugins/manifest)、[技能](/tools/skills)。

## 斜線指令

OpenProse 註冊了 `/prose` 作為使用者可呼叫的技能指令。該指令會導向 OpenProse VM 指令，並在底層使用 OpenClaw 工具。

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

prose

# 兩個代理同時執行的研究與綜合。

輸入主題: "我們應該研究什麼？"

代理 researcher:
模型: sonnet
提示: "你要徹底研究並引用來源。"

代理 writer:
模型: opus
提示: "你要寫出簡潔的摘要。"

平行:
findings = session: researcher
提示: "研究 {topic}。"
draft = session: writer
提示: "摘要 {topic}。"

會話 "將研究結果與草稿合併成最終答案。"
上下文: { findings, draft }

## 檔案位置

OpenProse 將狀態保存在你的工作區的 `.prose/`：

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

使用者層級的持久代理位於：

```
~/.prose/agents/
```

## 狀態模式

OpenProse 支援多種狀態後端：

- **filesystem**（預設）：`.prose/runs/...`
- **in-context**：暫態，適用於小型程式
- **sqlite**（實驗性）：需要 `sqlite3` 二進位檔
- **postgres**（實驗性）：需要 `psql` 及連線字串

備註：

- sqlite/postgres 為選用且實驗性功能。
- postgres 憑證會流入子代理日誌；請使用專用且權限最低的資料庫。

## 遠端程式

`/prose run <handle/slug>` 會解析為 `https://p.prose.md/<handle>/<slug>`。
直接的 URL 會照原樣擷取。此處使用 `web_fetch` 工具（POST 則使用 `exec`）。

## OpenClaw 執行時映射

OpenProse 程式對應到 OpenClaw 原語：

| OpenProse 概念      | OpenClaw 工具    |
| ------------------- | ---------------- |
| 啟動會話 / 任務工具 | `sessions_spawn` |
| 檔案讀取/寫入       | `read` / `write` |
| 網路擷取            | `web_fetch`      |

若您的工具允許清單封鎖這些工具，OpenProse 程式將無法執行。詳見 [技能設定](/tools/skills-config)。

## 安全性與審核

將 `.prose` 檔案視同程式碼。執行前請先審查。使用 OpenClaw 工具允許清單與審核閘道來控制副作用。

若需確定性且有審核閘道的工作流程，請參考 [Lobster](/tools/lobster)。
