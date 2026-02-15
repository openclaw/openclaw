---
summary: "智慧代理初始化儀式，用於產生工作空間和身分檔案"
read_when:
  - 了解智慧代理首次執行時發生的情況
  - 說明初始化檔案的存放位置
  - 排查新手導覽身分設定的疑難雜症
title: "智慧代理初始化"
sidebarTitle: "初始化"
---

# 智慧代理初始化

初始化（Bootstrapping）是**首次執行**的儀式，用於準備智慧代理工作空間並收集身分詳情。這發生在新手導覽之後，當智慧代理第一次啟動時執行。

## 初始化執行的操作

在智慧代理首次執行時，OpenClaw 會初始化工作空間（預設為 `~/.openclaw/workspace`）：

- 產生 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md`。
- 執行簡短的問答儀式（每次一個問題）。
- 將身分與偏好設定寫入 `IDENTITY.md`、`USER.md`、`SOUL.md`。
- 完成後移除 `BOOTSTRAP.md`，因此它只會執行一次。

## 執行位置

初始化一律在 **Gateway 主機**上執行。如果 macOS 應用程式連接到遠端 Gateway，則工作空間和初始化檔案會儲存在該遠端機器上。

<Note>
當 Gateway 在另一台機器上執行時，請在 Gateway 主機上編輯工作空間檔案（例如：`user @gateway-host:~/.openclaw/workspace`）。
</Note>

## 相關文件

- macOS 應用程式新手導覽：[新手導覽](/start/onboarding)
- 工作空間佈局：[智慧代理工作空間](/concepts/agent-workspace)
