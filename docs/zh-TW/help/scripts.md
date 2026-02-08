---
summary: "「儲存庫腳本：用途、範圍與安全注意事項」"
read_when:
  - 在儲存庫中執行腳本時
  - 在 ./scripts 底下新增或變更腳本時
title: "「腳本」"
x-i18n:
  source_path: help/scripts.md
  source_hash: efd220df28f20b33
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:17Z
---

# 腳本

`scripts/` 目錄包含用於本機工作流程與維運任務的輔助腳本。
當任務明確對應到某個腳本時再使用；否則請優先使用 CLI。

## 慣例

- 除非在文件或發行檢查清單中有引用，否則腳本皆為**選用**。
- 若已有 CLI 介面，請優先使用（例如：身分驗證監控使用 `openclaw models status --check`）。
- 假設腳本與主機相依；在新機器上執行前請先閱讀內容。

## 身分驗證監控腳本

身分驗證監控腳本的說明文件位於：
[/automation/auth-monitoring](/automation/auth-monitoring)

## 新增腳本時

- 保持腳本專注且具備文件說明。
- 在相關文件中新增簡短條目（若缺少則建立一份）。
