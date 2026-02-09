---
summary: "Agent bootstrapping ritual that seeds the workspace and identity files"
read_when:
  - 了解代理程式首次執行時會發生什麼事
  - Explaining where bootstrapping files live
  - Debugging onboarding identity setup
title: "代理程式啟動"
sidebarTitle: "Bootstrapping"
---

# 代理程式啟動

Bootstrapping is the **first‑run** ritual that prepares an agent workspace and
collects identity details. It happens after onboarding, when the agent starts
for the first time.

## What bootstrapping does

在代理程式首次執行時，OpenClaw 會啟動並初始化工作區（預設為
`~/.openclaw/workspace`）：

- 建立 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md`。
- Runs a short Q&A ritual (one question at a time).
- 將身分與偏好設定寫入 `IDENTITY.md`、`USER.md`、`SOUL.md`。
- 完成後移除 `BOOTSTRAP.md`，確保只執行一次。

## Where it runs

Bootstrapping always runs on the **gateway host**. If the macOS app connects to
a remote Gateway, the workspace and bootstrapping files live on that remote
machine.

<Note>
當 Gateway 閘道器執行在另一台機器上時，請在閘道器主機上編輯工作區檔案（例如 `user@gateway-host:~/.openclaw/workspace`）。
</Note>

## Related docs

- macOS 應用程式入門引導：[Onboarding](/start/onboarding)
- 工作區配置：[Agent workspace](/concepts/agent-workspace)
