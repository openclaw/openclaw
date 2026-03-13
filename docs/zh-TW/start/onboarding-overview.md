---
summary: Overview of OpenClaw onboarding options and flows
read_when:
  - Choosing an onboarding path
  - Setting up a new environment
title: Onboarding Overview
sidebarTitle: Onboarding Overview
---

# 新手導覽總覽

OpenClaw 支援多種新手導覽路徑，取決於 Gateway 執行的位置以及您偏好的提供者設定方式。

## 選擇您的新手導覽路徑

- 適用於 macOS、Linux 及 Windows（透過 WSL2）的 **CLI 精靈**。
- 適用於 Apple Silicon 或 Intel Mac 的 **macOS 應用程式**，提供引導式首次使用體驗。

## CLI 新手導覽精靈

在終端機中執行精靈：

```bash
openclaw onboard
```

當您想完全掌控 Gateway、工作區、頻道與技能時，請使用 CLI 精靈。相關文件：

- [新手導覽精靈 (CLI)](/start/wizard)
- [`openclaw onboard` 指令](/cli/onboard)

## macOS 應用程式新手導覽

當您想在 macOS 上進行全程引導設定時，請使用 OpenClaw 應用程式。相關文件：

- [新手導覽 (macOS 應用程式)](/start/onboarding)

## 自訂提供者

如果您需要的端點不在列表中，包括提供標準 OpenAI 或 Anthropic API 的託管提供者，請在 CLI 精靈中選擇 **自訂提供者**。系統會要求您：

- 選擇 OpenAI 相容、Anthropic 相容，或 **未知**（自動偵測）。
- 輸入基底 URL 及 API 金鑰（若提供者需要）。
- 提供模型 ID 及可選的別名。
- 選擇端點 ID，以便多個自訂端點能共存。

如需詳細步驟，請參考上述 CLI 新手教學文件。
