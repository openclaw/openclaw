---
summary: macOS permission persistence (TCC) and signing requirements
read_when:
  - Debugging missing or stuck macOS permission prompts
  - Packaging or signing the macOS app
  - Changing bundle IDs or app install paths
title: macOS Permissions
---

# macOS 權限 (TCC)

macOS 權限授予相當脆弱。TCC 將權限授予與應用程式的程式碼簽章、套件識別碼及磁碟路徑關聯。如果其中任何一項改變，macOS 會將該應用程式視為全新，並可能取消或隱藏提示。

## 穩定權限的需求

- 相同路徑：從固定位置執行應用程式（對 OpenClaw 為 `dist/OpenClaw.app`）。
- 相同套件識別碼：更改套件 ID 會建立新的權限身份。
- 已簽署的應用程式：未簽署或使用臨時簽章的建置不會保留權限。
- 一致的簽章：使用真正的 Apple Development 或 Developer ID 證書，讓簽章在重建時保持穩定。

臨時簽章每次建置都會產生新的身份。macOS 會忘記先前的授權，且提示可能完全消失，直到清除過期條目。

## 當提示消失時的復原清單

1. 退出應用程式。
2. 在「系統設定」->「隱私與安全性」中移除該應用程式的條目。
3. 從相同路徑重新啟動應用程式並重新授權。
4. 若提示仍未出現，使用 `tccutil` 重置 TCC 條目後再試一次。
5. 部分權限只有在完整重新啟動 macOS 後才會重新出現。

重置範例（視需要替換套件 ID）：

```bash
sudo tccutil reset Accessibility ai.openclaw.mac
sudo tccutil reset ScreenCapture ai.openclaw.mac
sudo tccutil reset AppleEvents
```

## 檔案與資料夾權限（桌面/文件/下載）

macOS 也可能限制終端機或背景程序對桌面、文件和下載資料夾的存取。如果檔案讀取或目錄列出操作卡住，請授權執行檔案操作的相同程序環境（例如 Terminal/iTerm、LaunchAgent 啟動的應用程式或 SSH 程序）。

解決方法：若想避免每個資料夾都要授權，可將檔案移至 OpenClaw 工作區 (`~/.openclaw/workspace`)。

若您正在測試權限，請務必使用真實證書簽署。臨時建置只適用於不需權限的快速本地執行。
