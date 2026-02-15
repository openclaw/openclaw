---
title: "建立 Skills"
---

# 建立自訂 Skills 🛠

OpenClaw 的設計目標是易於擴展。「Skills」是為您的智慧代理新增功能的主要方式。

## 什麼是 Skill？

Skill 是一個目錄，其中包含一個 `SKILL.md` 檔案 (提供指令和工具定義給 LLM)，以及選用的一些腳本或資源。

## 逐步教學：您的第一個 Skill

### 1. 建立目錄

Skills 儲存在您的工作區中，通常是 `~/.openclaw/workspace/skills/`。為您的 Skill 建立一個新資料夾：

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. 定義 `SKILL.md`

在該目錄中建立一個 `SKILL.md` 檔案。此檔案使用 YAML frontmatter 來定義中繼資料，並使用 Markdown 來編寫指令。

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

當使用者要求問候時，請使用 `echo` 工具說出「Hello from your custom skill!」。
```

### 3. 新增工具 (選用)

您可以在 frontmatter 中定義自訂工具，或指示智慧代理使用現有的系統工具 (例如 `bash` 或 `browser`)。

### 4. 重新整理 OpenClaw

請您的智慧代理「重新整理 skills」或重新啟動 Gateway。OpenClaw 將會探索新目錄並索引 `SKILL.md`。

## 最佳實踐

- **簡潔明瞭**：指導模型應該做_什麼_，而不是如何成為一個 AI。
- **安全至上**：如果您的 Skill 使用 `bash`，請確保提示不允許來自不受信任的使用者輸入進行任意指令注入。
- **本機測試**：使用 `openclaw agent --message "use my new skill"` 進行測試。

## 共享 Skills

您也可以瀏覽並貢獻 Skills 到 [ClawHub](https://clawhub.com)。
