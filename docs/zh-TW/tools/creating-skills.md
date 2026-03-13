---
title: Creating Skills
summary: Build and test custom workspace skills with SKILL.md
read_when:
  - You are creating a new custom skill in your workspace
  - You need a quick starter workflow for SKILL.md-based skills
---

# 建立自訂技能 🛠

OpenClaw 設計上易於擴充。「技能」是為你的助理新增功能的主要方式。

## 什麼是技能？

技能是一個目錄，裡面包含一個 `SKILL.md` 檔案（提供給大型語言模型指令和工具定義），並且可選擇包含一些腳本或資源。

## 逐步教學：你的第一個技能

### 1. 建立目錄

技能存放在你的工作區，通常是 `~/.openclaw/workspace/skills/`。為你的技能建立一個新資料夾：

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. 定義 `SKILL.md`

在該目錄中建立一個 `SKILL.md` 檔案。此檔案使用 YAML frontmatter 來撰寫元資料，並用 Markdown 撰寫指令。

## markdown

name: hello_world
description: 一個簡單的技能，會打招呼。

---

# Hello World 技能

當使用者要求問候時，使用 `echo` 工具說「Hello from your custom skill!」。

### 3. 新增工具（可選）

你可以在 frontmatter 中定義自訂工具，或指示代理使用現有系統工具（例如 `bash` 或 `browser`）。

### 4. 重新整理 OpenClaw

請求您的代理程式「重新整理技能」或重新啟動閘道。OpenClaw 將會發現新的目錄並建立 `SKILL.md` 的索引。

## 最佳實踐

- **簡潔明瞭**：指示模型 _要做什麼_，而非如何成為 AI。
- **安全優先**：如果您的技能使用 `bash`，請確保提示不允許從不受信任的使用者輸入中注入任意指令。
- **本地測試**：使用 `openclaw agent --message "use my new skill"` 進行測試。

## 共享技能

您也可以瀏覽並貢獻技能至 [ClawHub](https://clawhub.com)。
