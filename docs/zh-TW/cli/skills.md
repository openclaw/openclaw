---
summary: "用於 `openclaw skills`（list/info/check）與技能資格判定的 CLI 參考文件"
read_when:
  - 你想查看哪些 Skills 可用且已準備好執行
  - 你想除錯 Skills 缺少的二進位檔、環境變數或設定
title: "skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:29Z
---

# `openclaw skills`

檢視 Skills（內建 + 工作區 + 受管覆寫），並查看哪些符合資格、哪些缺少需求。

相關：

- Skills 系統：[Skills](/tools/skills)
- Skills 設定：[Skills config](/tools/skills-config)
- ClawHub 安裝：[ClawHub](/tools/clawhub)

## 指令

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
