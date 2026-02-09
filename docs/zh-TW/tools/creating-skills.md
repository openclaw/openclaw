---
title: "建立 Skills"
---

# 建立自訂 Skills 🛠

OpenClaw is designed to be easily extensible. "Skills" are the primary way to add new capabilities to your assistant.

## 什麼是 Skill？

Skill 是一個目錄，內含一個 `SKILL.md` 檔案（用於向 LLM 提供指示與工具定義），並且可選擇性地包含一些腳本或資源。

## 逐步教學：你的第一個 Skill

### 1. 建立目錄

Skills 會存在於你的工作區，通常位於 `~/.openclaw/workspace/skills/`。為你的 Skill 建立一個新資料夾： Create a new folder for your skill:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. 定義 `SKILL.md`

Create a `SKILL.md` file in that directory. 在該目錄中建立一個 `SKILL.md` 檔案。此檔案使用 YAML frontmatter 作為中繼資料，並以 Markdown 撰寫指示內容。

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. 新增工具（選用）

你可以在 frontmatter 中定義自訂工具，或指示代理程式使用現有的系統工具（例如 `bash` 或 `browser`）。

### 4. 重新整理 OpenClaw

Ask your agent to "refresh skills" or restart the gateway. OpenClaw will discover the new directory and index the `SKILL.md`.

## 最佳實務

- **簡潔明確**：指示模型「要做什麼」，而不是如何成為 AI。
- **安全優先**：如果你的 Skill 使用 `bash`，請確保提示不會允許來自不受信任使用者輸入的任意指令注入。
- **在本機測試**：使用 `openclaw agent --message "use my new skill"` 進行測試。

## 共用 Skills

你也可以在 [ClawHub](https://clawhub.com) 瀏覽並貢獻 Skills。
