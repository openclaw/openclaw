---
summary: "macOS 偵錯版本（debug builds）由打包腳本生成的簽署步驟"
read_when:
  - 建置或簽署 macOS 偵錯版本時
title: "macOS 簽署"
---

# mac 簽署 (偵錯版本)

此應用程式通常是透過 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 建置的，該腳本現在會執行以下操作：

- 設定穩定的偵錯應用程式識別碼：`ai.openclaw.mac.debug`
- 寫入包含該應用程式識別碼的 Info.plist 檔案 (可透過 `BUNDLE_ID=...` 覆寫)
- 呼叫 [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) 來簽署主要二進位檔和應用程式包，以便 macOS 將每次重建視為相同的簽署應用程式包，並保留 TCC 權限 (通知、輔助使用、螢幕錄影、麥克風、語音)。為了獲得穩定的權限，請使用真實的簽署身分；臨時簽署是選擇性啟用且脆弱的 (請參閱 [macOS 權限](/platforms/mac/permissions))。
- 預設使用 `CODESIGN_TIMESTAMP=auto`；它為開發者 ID 簽章啟用信任時間戳記。設定 `CODESIGN_TIMESTAMP=off` 以跳過時間戳記 (離線偵錯版本建置)。
- 將建置後設資料注入 Info.plist 檔案：`OpenClawBuildTimestamp` (UTC) 和 `OpenClawGitCommit` (簡短 Git 雜湊)，以便「關於」面板可以顯示建置、Git 和偵錯/發布通道。
- **打包需要 Node 22+**：此腳本會執行 TypeScript 建置和控制 UI 建置。
- 從環境讀取 `SIGN_IDENTITY`。將 `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (或您的開發者 ID 應用程式憑證) 加入您的 shell rc 檔案，以便始終使用您的憑證進行簽署。臨時簽署需要透過 `ALLOW_ADHOC_SIGNING=1` 或 `SIGN_IDENTITY="-"` 明確選擇啟用 (不建議用於權限測試)。
- 簽署後會執行團隊 ID 稽核，如果應用程式包內部的任何 Mach-O 檔案由不同的團隊 ID 簽署，則會失敗。設定 `SKIP_TEAM_ID_CHECK=1` 以繞過此檢查。

## 用法

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### 臨時簽署注意事項

當使用 `SIGN_IDENTITY="-"` (臨時) 進行簽署時，腳本會自動停用 **強化執行期** (`--options runtime`)。這對於防止應用程式嘗試載入不共享相同團隊 ID 的嵌入式框架 (如 Sparkle) 時發生崩潰是必要的。臨時簽章還會破壞 TCC 權限持久性；請參閱 [macOS 權限](/platforms/mac/permissions) 以獲取恢復步驟。

## 關於建置後設資料

`package-mac-app.sh` 會為應用程式包標記：

- `OpenClawBuildTimestamp`: 打包時的 ISO8601 UTC 時間
- `OpenClawGitCommit`: 簡短 Git 雜湊 (如果不可用則為 `unknown`)

「關於」分頁會讀取這些鍵值以顯示版本、建置日期、Git 提交以及是否為偵錯版本 (透過 `#if DEBUG`)。在程式碼變更後執行打包器以更新這些值。

## 原因

TCC 權限與應用程式識別碼和程式碼簽章綁定。未簽署的偵錯版本建置與變動的 UUIDs 導致 macOS 在每次重建後忘記授權。簽署二進位檔 (預設為臨時簽署) 並保持固定的應用程式識別碼/路徑 (`dist/OpenClaw.app`) 可保留各版本之間的授權，這與 VibeTunnel 的方法一致。
