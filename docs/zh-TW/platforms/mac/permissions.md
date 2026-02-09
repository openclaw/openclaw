---
summary: "macOS 權限持久化（TCC）與簽署需求"
read_when:
  - 偵錯 macOS 權限提示遺失或卡住
  - 封裝或簽署 macOS 應用程式
  - 變更套件識別碼或應用程式安裝路徑
title: "macOS 權限"
---

# macOS 權限（TCC）

macOS permission grants are fragile. TCC associates a permission grant with the
app's code signature, bundle identifier, and on-disk path. If any of those change,
macOS treats the app as new and may drop or hide prompts.

## 穩定權限的需求

- 相同路徑：從固定位置執行應用程式（對於 OpenClaw，`dist/OpenClaw.app`）。
- 相同套件識別碼：變更套件 ID 會建立新的權限身分。
- 已簽署的應用程式：未簽署或 ad-hoc 簽署的組建不會持久保存權限。
- 一致的簽章：使用真正的 Apple Development 或 Developer ID 憑證，
  以確保在重新組建之間簽章保持穩定。

Ad-hoc signatures generate a new identity every build. macOS will forget previous
grants, and prompts can disappear entirely until the stale entries are cleared.

## 當提示消失時的復原檢查清單

1. Quit the app.
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

macOS may also gate Desktop, Documents, and Downloads for terminal/background processes. If file reads or directory listings hang, grant access to the same process context that performs file operations (for example Terminal/iTerm, LaunchAgent-launched app, or SSH process).

因應方式：若想避免逐資料夾授權，可將檔案移至 OpenClaw 工作區（`~/.openclaw/workspace`）。

If you are testing permissions, always sign with a real certificate. Ad-hoc
builds are only acceptable for quick local runs where permissions do not matter.
