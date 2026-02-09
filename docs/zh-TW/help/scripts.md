---
summary: "Repository 腳本：用途、範圍與安全注意事項"
read_when:
  - 從 repo 執行腳本
  - 在 ./scripts 底下新增或變更腳本時
title: "Scripts"
---

# Scripts

`scripts/` 目錄包含用於本機工作流程與維運任務的輔助腳本。
當任務明確與某個腳本相關時再使用；否則請優先使用 CLI。

## 慣例

- 17. 除非文件或發佈檢查清單中有提及，否則腳本皆為**選用**。
- 若已有 CLI 介面，請優先使用（例如：身分驗證監控使用 `openclaw models status --check`）。
- 假設腳本是主機特定的；在新機器上執行前請先閱讀。

## 19. 驗證監控腳本

Auth 監控腳本文件在此：
[/automation/auth-monitoring](/automation/auth-monitoring)

## 新增腳本時

- 保持腳本專注且有文件說明。
- 在相關文件中新增一則簡短說明（若沒有則建立）。
