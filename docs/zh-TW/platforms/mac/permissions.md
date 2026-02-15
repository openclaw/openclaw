---
summary: "macOS 權限持續性 (TCC) 與簽署要求"
read_when:
  - 除錯遺失或卡住的 macOS 權限提示
  - 打包或簽署 macOS 應用程式
  - 變更 bundle ID 或應用程式安裝路徑
title: "macOS 權限"
---

# macOS 權限 (TCC)

macOS 的權限授予相當脆弱。TCC 會將權限授予與應用程式的程式碼簽署 (code signature)、bundle identifier 以及磁碟上的路徑關聯。如果其中任何一項發生變化，macOS 會將該應用程式視為新程式，並可能捨棄或隱藏提示。

## 穩定權限的要求

- 相同路徑：從固定位置執行應用程式（對於 OpenClaw 為 `dist/OpenClaw.app`）。
- 相同 bundle identifier：變更 bundle ID 會建立新的權限識別身分。
- 已簽署的應用程式：未簽署或臨機 (ad-hoc) 簽署的建置版本無法持久保留權限。
- 一致的簽署：使用真實的 Apple Development 或 Developer ID 憑證，使簽署在重新建置時保持穩定。

臨機 (Ad-hoc) 簽署在每次建置時都會產生新的識別身分。macOS 會忘記之前的授權，且提示可能會完全消失，直到清除舊有的項目。

## 提示消失時的復原檢查清單

1. 退出應用程式。
2. 在「系統設定」->「隱私權與安全性」中移除該應用程式項目。
3. 從相同路徑重新啟動應用程式並重新授予權限。
4. 如果提示仍未出現，請使用 `tccutil` 重設 TCC 項目並再試一次。
5. 某些權限僅在完整重啟 macOS 後才會重新出現。

範例重設命令（根據需要替換 bundle ID）：

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## 檔案與資料夾權限 (桌面/文件/下載)

macOS 也可能對終端機/背景程序存取「桌面」、「文件」和「下載」資料夾進行限制。如果讀取檔案或列出目錄內容時發生卡頓，請將存取權授予執行檔案操作的相同程序內容（例如 Terminal/iTerm、由 LaunchAgent 啟動的應用程式或 SSH 程序）。

解決方法：如果您想避免針對個別資料夾進行授權，請將檔案移至 OpenClaw 工作區 (`~/.openclaw/workspace`)。

如果您正在測試權限，請務必使用真實憑證進行簽署。臨機 (Ad-hoc) 建置僅適用於權限無關緊要的快速本地執行。
