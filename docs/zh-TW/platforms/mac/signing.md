---
summary: "由打包腳本產生的 macOS debug 版本簽署步驟"
read_when:
  - 構建或簽署 mac debug 版本時
title: "macOS 簽署"
---

# mac 簽署 (debug 版本)

此應用程式通常是透過 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 構建的，該腳本現在：

- 設定穩定的 debug bundle identifier：`ai.openclaw.mac.debug`
- 使用該 bundle id 寫入 Info.plist（可透過 `BUNDLE_ID=...` 覆蓋）
- 呼叫 [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) 來簽署主執行檔與 app bundle，讓 macOS 將每次重新構建視為同一個已簽署的 bundle，並保留 TCC 權限（通知、輔助功能、螢幕錄製、麥克風、語音）。若要獲得穩定的權限，請使用真實的簽署身分；ad-hoc 是選擇性加入的且較不穩定（參見 [macOS 權限](/platforms/mac/permissions)）。
- 預設使用 `CODESIGN_TIMESTAMP=auto`；它會為 Developer ID 簽署啟用受信任的時間戳記。設定 `CODESIGN_TIMESTAMP=off` 可跳過時間戳記（離線 debug 構建）。
- 將構建中繼資料注入 Info.plist：`OpenClawBuildTimestamp` (UTC) 與 `OpenClawGitCommit` (簡短雜湊值)，讓「關於」面板能顯示構建資訊、git 以及 debug/release 頻道。
- **打包需要 Node 22+**：該腳本會執行 TS 構建與 Control UI 構建。
- 從環境變數讀取 `SIGN_IDENTITY`。將 `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"`（或您的 Developer ID Application 憑證）加入您的 shell rc，以便始終使用您的憑證進行簽署。Ad-hoc 簽署需要透過 `ALLOW_ADHOC_SIGNING=1` 或 `SIGN_IDENTITY="-"` 明確選擇加入（不建議用於權限測試）。
- 簽署後會執行 Team ID 稽核，若 app bundle 內的任何 Mach-O 是由不同的 Team ID 簽署，則會失敗。設定 `SKIP_TEAM_ID_CHECK=1` 可跳過此檢查。

## 用法

```bash
# 從儲存庫根目錄執行
scripts/package-mac-app.sh               # 自動選擇身分；若未找到則報錯
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # 真實憑證
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc（權限不會保留）
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # 明確的 ad-hoc（同樣的限制）
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # 僅限開發使用的 Sparkle Team ID 不匹配解決方案
```

### Ad-hoc 簽署注意事項

當使用 `SIGN_IDENTITY="-"` (ad-hoc) 簽署時，腳本會自動停用 **Hardened Runtime** (`--options runtime`)。這是為了防止應用程式嘗試載入不具備相同 Team ID 的內嵌框架（例如 Sparkle）時發生當機。Ad-hoc 簽署也會破壞 TCC 權限的持久性；有關恢復步驟，請參見 [macOS 權限](/platforms/mac/permissions)。

## 「關於」中的構建中繼資料

`package-mac-app.sh` 會在 bundle 中標記：

- `OpenClawBuildTimestamp`：打包時的 ISO8601 UTC 時間
- `OpenClawGitCommit`：簡短 git 雜湊值（若不可用則為 `unknown`）

「關於」分頁會讀取這些鍵值以顯示版本、構建日期、git 雜湊值，以及是否為 debug 版本（透過 `#if DEBUG`）。修改程式碼後，請執行打包程式以更新這些值。

## 為什麼要這麼做

TCC 權限與 bundle identifier 及程式碼簽署綁定。未簽署且 UUID 不斷變化的 debug 版本會導致 macOS 在每次重新構建後忘記已授權的權限。簽署執行檔（預設為 ad-hoc）並保持固定的 bundle id/路徑 (`dist/OpenClaw.app`) 可以跨版本保留權限，這與 VibeTunnel 的做法一致。
