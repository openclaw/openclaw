---
summary: "OpenClaw 新手導覽選項與流程概覽"
read_when:
  - 選擇新手導覽路徑
  - 設定新環境
title: "新手導覽概覽"
sidebarTitle: "新手導覽概覽"
---

# 新手導覽概覽

OpenClaw 支援多種新手導覽路徑，具體取決於 Gateway 執行的位置以及您偏好的供應商設定方式。

## 選擇您的新手導覽路徑

- **CLI 精靈**：適用於 macOS、Linux 和 Windows (透過 WSL2)。
- **macOS 應用程式**：在 Apple 晶片或 Intel Mac 上進行引導式的首次執行。

## CLI 新手導覽精靈

在終端機中執行精靈：

```bash
openclaw onboard
```

當您想要完全控制 Gateway、工作空間、頻道以及 Skills 時，請使用 CLI 精靈。相關文件：

- [新手導覽精靈 (CLI)](/start/wizard)
- [`openclaw onboard` 指令](/cli/onboard)

## macOS 應用程式新手導覽

當您想要在 macOS 上進行完全引導式的設定時，請使用 OpenClaw 應用程式。相關文件：

- [新手導覽 (macOS 應用程式)](/start/onboarding)

## 自訂供應商

如果您需要的端點未列出（包括提供標準 OpenAI 或 Anthropic API 的代管供應商），請在 CLI 精靈中選擇 **Custom Provider**。您將被要求：

- 選擇 OpenAI 相容、Anthropic 相容或 **Unknown** (自動偵測)。
- 輸入 Base URL 和 API 金鑰（如果供應商要求）。
- 提供模型 ID 和選填的別名。
- 選擇一個端點 ID，以便多個自訂端點可以共存。

如需詳細步驟，請參考上方的 CLI 新手導覽文件。
