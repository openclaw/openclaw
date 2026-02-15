---
summary: "macOS 權限持久性 (TCC) 和簽章要求"
read_when:
  - 除錯 macOS 權限提示遺失或卡住的問題
  - 封裝或簽章 macOS 應用程式
  - 更改套件識別碼或應用程式安裝路徑
title: "macOS 權限"
---

# macOS 權限 (TCC)

macOS 權限授予是脆弱的。TCC 將權限授予與應用程式的程式碼簽章、套件識別碼以及磁碟上的路徑相關聯。如果其中任何一項發生變更，macOS 會將該應用程式視為新應用程式，並可能捨棄或隱藏提示。

## 穩定權限的要求

- 相同路徑：從固定位置執行應用程式 (對於 OpenClaw，為 `dist/OpenClaw.app`)。
- 相同套件識別碼：更改套件 ID 會建立新的權限識別。
- 已簽章應用程式：未簽章或臨時簽章的建置不會保留權限。
- 一致的簽章：使用真實的 Apple Development 或 Developer ID 憑證，以確保簽章在重建後保持穩定。

臨時簽章在每次建置時都會生成新的識別。macOS 將會忘記先前的授予，提示可能會完全消失，直到清除過期的條目。

## 提示消失時的復原清單

1. 退出應用程式。
2. 在「系統設定」->「隱私權與安全性」中移除應用程式條目。
3. 從相同路徑重新啟動應用程式並重新授予權限。
4. 如果提示仍未出現，請使用 `tccutil` 重設 TCC 條目並重試。
5. 某些權限只有在 macOS 完全重新啟動後才會重新出現。

重設範例 (根據需要替換套件 ID)：

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## 檔案和檔案夾權限 (桌面/文件/下載)

macOS 也可能限制終端機/背景程序存取桌面、文件和下載。如果檔案讀取或檔案夾列表卡住，請授予執行檔案操作的相同程序環境存取權 (例如 Terminal/iTerm、LaunchAgent 啟動的應用程式或 SSH 程序)。

變通方法：如果您想避免單獨檔案夾的授予，請將檔案移至 OpenClaw 工作區 (`~/.openclaw/workspace`)。

如果您正在測試權限，請務必使用真實憑證進行簽章。臨時建置僅適用於權限不重要的快速本機執行。
