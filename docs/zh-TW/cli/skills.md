---
summary: "用於 `openclaw skills`（list/info/check）與技能資格判定的 CLI 參考文件"
read_when:
  - 你想查看哪些 Skills 可用且已準備好執行
  - 25. 你想要除錯技能缺少的二進位檔／環境變數／設定
title: "skills"
---

# `openclaw skills`

檢視 Skills（內建 + 工作區 + 受管覆寫），並查看哪些符合資格、哪些缺少需求。

26. 相關：

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
