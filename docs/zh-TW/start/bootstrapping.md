---
summary: 「為代理程式建立工作區與身分檔案的啟動儀式」
read_when:
  - 了解代理程式首次執行時會發生什麼事
  - 說明啟動檔案存放的位置
  - 除錯入門引導的身分設定
title: 「代理程式啟動」
sidebarTitle: 「啟動」
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:12Z
---

# 代理程式啟動

啟動（Bootstrapping）是 **首次執行** 的儀式，用來準備代理程式的工作區並蒐集身分詳細資訊。它發生在入門引導之後，代理程式第一次啟動時。

## 啟動會做什麼

在代理程式首次執行時，OpenClaw 會啟動並初始化工作區（預設為
`~/.openclaw/workspace`）：

- 建立 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md`。
- 執行一個簡短的問答儀式（一次一個問題）。
- 將身分與偏好設定寫入 `IDENTITY.md`、`USER.md`、`SOUL.md`。
- 完成後移除 `BOOTSTRAP.md`，確保只執行一次。

## 執行位置

啟動一律在 **閘道器主機** 上執行。如果 macOS 應用程式連線到遠端 Gateway 閘道器，工作區與啟動檔案會存在於該遠端機器上。

<Note>
當 Gateway 閘道器執行在另一台機器上時，請在閘道器主機上編輯工作區檔案（例如 `user@gateway-host:~/.openclaw/workspace`）。
</Note>

## 相關文件

- macOS 應用程式入門引導：[Onboarding](/start/onboarding)
- 工作區配置：[Agent workspace](/concepts/agent-workspace)
