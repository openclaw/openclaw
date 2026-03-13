---
summary: "Repository scripts: purpose, scope, and safety notes"
read_when:
  - Running scripts from the repo
  - Adding or changing scripts under ./scripts
title: Scripts
---

# Scripts

`scripts/` 目錄包含用於本地工作流程和操作任務的輔助腳本。當任務明確與腳本相關時，請使用這些腳本；否則請優先使用 CLI。

## 約定事項

- 腳本是 **選擇性的**，除非在文件或發佈檢查清單中有提及。
- 當 CLI 界面存在時，優先使用 CLI 界面（例如：身份驗證監控使用 `openclaw models status --check`）。
- 假設腳本是主機特定的；在新機器上執行之前請先閱讀它們。

## Auth monitoring scripts

身份驗證監控腳本的文件在這裡：
[/automation/auth-monitoring](/automation/auth-monitoring)

## 當添加腳本時

- 保持腳本專注且有文件記錄。
- 在相關文件中添加簡短的條目（如果缺少則創建一個）。
