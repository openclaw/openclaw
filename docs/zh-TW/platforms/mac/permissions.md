---
summary: "macOS 權限持久化（TCC）與簽署需求"
read_when:
  - 偵錯 macOS 權限提示遺失或卡住
  - 封裝或簽署 macOS 應用程式
  - 變更套件識別碼或應用程式安裝路徑
title: "macOS 權限"
x-i18n:
  source_path: platforms/mac/permissions.md
  source_hash: 52bee5c896e31e99
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:46Z
---

# macOS 權限（TCC）

macOS 的權限授與相當脆弱。TCC 會將權限授與關聯到
應用程式的程式碼簽章、套件識別碼，以及磁碟上的路徑。只要其中任何一項變更，
macOS 就會將該應用程式視為新的，並可能移除或隱藏提示。

## 穩定權限的需求

- 相同路徑：從固定位置執行應用程式（對於 OpenClaw，`dist/OpenClaw.app`）。
- 相同套件識別碼：變更套件 ID 會建立新的權限身分。
- 已簽署的應用程式：未簽署或 ad-hoc 簽署的組建不會持久保存權限。
- 一致的簽章：使用真正的 Apple Development 或 Developer ID 憑證，
  以確保在重新組建之間簽章保持穩定。

Ad-hoc 簽章每次組建都會產生新的身分。macOS 會忘記先前的授權，
而提示甚至可能完全消失，直到清除過時的項目為止。

## 當提示消失時的復原檢查清單

1. 結束應用程式。
2. 在「系統設定」->「隱私權與安全性」中移除應用程式項目。
3. 從相同路徑重新啟動應用程式並重新授與權限。
4. 若提示仍未出現，使用 `tccutil` 重設 TCC 項目後再試一次。
5. 有些權限只有在完整重新啟動 macOS 後才會再次出現。

重設範例（請視需要替換套件識別碼）：

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## 檔案與資料夾權限（桌面／文件／下載）

macOS 也可能會對終端機或背景處理程序存取「桌面」、「文件」與「下載」進行限制。若檔案讀取或目錄列出卡住，請將存取權授與執行檔案操作的相同處理程序情境（例如 Terminal／iTerm、由 LaunchAgent 啟動的應用程式，或 SSH 處理程序）。

因應方式：若想避免逐資料夾授權，可將檔案移至 OpenClaw 工作區（`~/.openclaw/workspace`）。

如果你正在測試權限，請務必使用真正的憑證進行簽署。Ad-hoc
組建僅適用於快速的本機執行、且不需要權限的情境。
