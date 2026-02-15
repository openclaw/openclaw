---
title: "建立 Skills"
---

# 建立自定義 Skills 🛠

OpenClaw 的設計旨在易於擴充。「Skills」是為你的智慧代理新增功能的主要方式。

## 什麼是 Skill？

Skill 是一個包含 `SKILL.md` 檔案（為 LLM 提供指令和工具定義）的目錄，並可選擇性地包含一些腳本或資源。

## 逐步教學：你的第一個 Skill

### 1. 建立目錄

Skills 儲存在你的工作區，通常位於 `~/.openclaw/workspace/skills/`。為你的 Skill 建立一個新資料夾：

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. 定義 `SKILL.md`

在該目錄中建立一個 `SKILL.md` 檔案。此檔案使用 YAML frontmatter 來定義詮釋資料，並使用 Markdown 來編寫指令。

```markdown
---
name: hello_world
description: 一個會打招呼的簡單 skill。
---

# Hello World Skill

當使用者要求問候時，使用 `echo` 工具說出 "Hello from your custom skill!"。
```

### 3. 新增工具（選填）

你可以在 frontmatter 中定義自定義工具，或指示智慧代理使用現有的系統工具（如 `bash` 或 `browser`）。

### 4. 重新整理 OpenClaw

要求你的智慧代理「重新整理 skills」或重新啟動 Gateway。OpenClaw 將會偵測到新目錄並為 `SKILL.md` 建立索引。

## 最佳實踐

- **保持簡潔**：指示模型「做什麼」，而不是如何當一個 AI。
- **安全至上**：如果你的 Skill 使用 `bash`，請確保提示詞不會允許來自不受信任使用者輸入的任意指令注入。
- **本地測試**：使用 `openclaw agent --message "use my new skill"` 進行測試。

## 共享 Skills

你也可以在 [ClawHub](https://clawhub.com) 瀏覽或貢獻 Skills。
