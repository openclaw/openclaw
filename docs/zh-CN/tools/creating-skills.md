---
title: 创建技能
x-i18n:
  generated_at: "2026-02-01T21:42:12Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ad801da34fe361ffa584ded47f775d1c104a471a3f7b7f930652255e98945c3a
  source_path: tools/creating-skills.md
  workflow: 15
---

# 创建自定义技能 🛠

OpenClaw 的设计易于扩展。"技能"是为你的助手添加新功能的主要方式。

## 什么是技能？

技能是一个包含 `SKILL.md` 文件（为 LLM 提供指令和工具定义）的目录，还可以选择性地包含一些脚本或资源。

## 分步指南：你的第一个技能

### 1. 创建目录

技能存放在你的工作区中，通常位于 `~/.openclaw/workspace/skills/`。为你的技能创建一个新文件夹：

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. 定义 `SKILL.md`

在该目录中创建一个 `SKILL.md` 文件。该文件使用 YAML frontmatter 存放元数据，使用 Markdown 编写指令。

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. 添加工具（可选）

你可以在 frontmatter 中定义自定义工具，或指示智能体使用现有的系统工具（如 `bash` 或 `browser`）。

### 4. 刷新 OpenClaw

让你的智能体"刷新技能"或重启 Gateway。OpenClaw 将发现新目录并索引 `SKILL.md`。

## 最佳实践

- **保持简洁**：指示模型应该做*什么*，而不是如何成为一个 AI。
- **安全第一**：如果你的技能使用 `bash`，请确保提示不会允许来自不受信任用户输入的任意命令注入。
- **本地测试**：使用 `openclaw agent --message "use my new skill"` 进行测试。

## 共享技能

你还可以在 [ClawHub](https://clawhub.com) 上浏览和贡献技能。
