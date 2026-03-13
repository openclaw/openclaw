---
summary: Agent bootstrapping ritual that seeds the workspace and identity files
read_when:
  - Understanding what happens on the first agent run
  - Explaining where bootstrapping files live
  - Debugging onboarding identity setup
title: Agent Bootstrapping
sidebarTitle: Bootstrapping
---

# 代理程式啟動設定

啟動設定是代理程式**首次執行**時的流程，用來準備代理程式工作區並收集身份資訊。此流程會在代理程式首次啟動後，完成入門設定時執行。

## 啟動設定的功能

在代理程式首次執行時，OpenClaw 會對工作區進行啟動設定（預設為 `~/.openclaw/workspace`）：

- 初始化 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md`。
- 進行簡短的問答流程（一次一題）。
- 將身份與偏好設定寫入 `IDENTITY.md`、`USER.md`、`SOUL.md`。
- 完成後移除 `BOOTSTRAP.md`，確保此流程只執行一次。

## 執行位置

啟動設定總是在**閘道主機**上執行。如果 macOS 應用程式連接到遠端閘道，工作區與啟動設定檔案會存放在該遠端主機上。

<Note>
當閘道執行於另一台機器時，請在閘道主機上編輯工作區檔案（例如 `user@gateway-host:~/.openclaw/workspace`）。
</Note>

## 相關文件

- macOS 應用程式入門設定：[Onboarding](/start/onboarding)
- 工作區結構：[Agent workspace](/concepts/agent-workspace)
