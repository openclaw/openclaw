---
summary: "OpenClaw 入門選項和流程概覽"
read_when:
  - 選擇入門路徑
  - 設定新環境
title: "入門概覽"
sidebarTitle: "入門概覽"
---

# 入門概覽

OpenClaw 支援多種入門路徑，具體取決於 Gateway 的運行位置以及您偏好的提供者設定方式。

## 選擇您的入門路徑

- **CLI 精靈**適用於 macOS、Linux 和 Windows (透過 WSL2)。
- **macOS 應用程式**適用於 Apple 晶片或 Intel Mac 上的引導式首次執行。

## CLI 入門精靈

在終端機中執行精靈：

```bash
openclaw onboard
```

當您希望完全控制 Gateway、工作區、通道和技能時，請使用 CLI 精靈。文件：

- [入門精靈 (CLI)](/start/wizard)
- [`openclaw onboard` 指令](/cli/onboard)

## macOS 應用程式入門

當您希望在 macOS 上進行完全引導式設定時，請使用 OpenClaw 應用程式。文件：

- [入門 (macOS 應用程式)](/start/onboarding)

## 自訂提供者

如果您需要列表中未提供的端點，包括公開標準 OpenAI 或 Anthropic API 的託管提供者，請在 CLI 精靈中選擇**自訂提供者**。您將會被要求：

- 選擇 OpenAI 相容、Anthropic 相容或**未知**（自動偵測）。
- 輸入基礎 URL 和 API 金鑰（如果提供者要求）。
- 提供模型 ID 和選用的別名。
- 選擇一個端點 ID，以便多個自訂端點可以共存。

有關詳細步驟，請參閱上述 CLI 入門文件。
