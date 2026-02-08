---
title: "建立 Skills"
x-i18n:
  source_path: tools/creating-skills.md
  source_hash: ad801da34fe361ff
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:23Z
---

# 建立自訂 Skills 🛠

OpenClaw 的設計目標是易於擴充。「Skills」是為你的助理新增新功能的主要方式。

## 什麼是 Skill？

Skill 是一個目錄，內含一個 `SKILL.md` 檔案（用於向 LLM 提供指示與工具定義），並且可選擇性地包含一些腳本或資源。

## 逐步教學：你的第一個 Skill

### 1. 建立目錄

Skills 會存在於你的工作區，通常位於 `~/.openclaw/workspace/skills/`。為你的 Skill 建立一個新資料夾：

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. 定義 `SKILL.md`

在該目錄中建立一個 `SKILL.md` 檔案。此檔案使用 YAML frontmatter 作為中繼資料，並以 Markdown 撰寫指示內容。

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

請你的代理程式「refresh skills」，或重新啟動 Gateway 閘道器。OpenClaw 會探索新的目錄並索引 `SKILL.md`。

## 最佳實務

- **簡潔明確**：指示模型「要做什麼」，而不是如何成為 AI。
- **安全優先**：如果你的 Skill 使用 `bash`，請確保提示不會允許來自不受信任使用者輸入的任意指令注入。
- **在本機測試**：使用 `openclaw agent --message "use my new skill"` 進行測試。

## 共用 Skills

你也可以在 [ClawHub](https://clawhub.com) 瀏覽並貢獻 Skills。
