---
summary: "由封裝腳本產生的 macOS 除錯組建之簽署步驟"
read_when:
  - 建置或簽署 mac 除錯組建時
title: "macOS 簽署"
---

# mac 簽署（除錯組建）

此應用程式通常由 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 建置，而該腳本現在會：

- 設定穩定的除錯套件識別碼：`ai.openclaw.mac.debug`
- 使用該套件識別碼寫入 Info.plist（可透過 `BUNDLE_ID=...` 覆寫）
- 呼叫 [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) 來簽署主要二進位檔與 App 套件，讓 macOS 將每次重建視為同一個已簽署的套件，並保留 TCC 權限（通知、輔助使用、螢幕錄製、麥克風、語音）。若要獲得穩定的權限，請使用正式的簽署身分；ad-hoc 為選用且脆弱（請參見 [macOS 權限](/platforms/mac/permissions)）。 For stable permissions, use a real signing identity; ad-hoc is opt-in and fragile (see [macOS permissions](/platforms/mac/permissions)).
- 預設使用 `CODESIGN_TIMESTAMP=auto`；它會為 Developer ID 簽章啟用受信任的時間戳。設定 `CODESIGN_TIMESTAMP=off` 以略過時間戳（離線除錯組建）。 Set `CODESIGN_TIMESTAMP=off` to skip timestamping (offline debug builds).
- 將建置中繼資料注入 Info.plist：`OpenClawBuildTimestamp`（UTC）與 `OpenClawGitCommit`（短雜湊），讓「關於」窗格可顯示建置、git，以及除錯／發行通道。
- **封裝需要 Node 22+**：腳本會執行 TS 建置與 Control UI 建置。
- reads `SIGN_IDENTITY` from the environment. 從環境讀取 `SIGN_IDENTITY`。將 `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"`（或你的 Developer ID Application 憑證）加入你的 shell rc，以一律使用你的憑證簽署。ad-hoc 簽署需要透過 `ALLOW_ADHOC_SIGNING=1` 或 `SIGN_IDENTITY="-"` 明確選用（不建議用於權限測試）。 臨時（Ad-hoc）簽署需要明確選擇加入，需設定 `ALLOW_ADHOC_SIGNING=1` 或 `SIGN_IDENTITY="-"`（不建議用於權限測試）。
- 簽署後執行 Team ID 稽核；若 App 套件內任何 Mach-O 由不同的 Team ID 簽署則失敗。設定 `SKIP_TEAM_ID_CHECK=1` 可略過。 設定 `SKIP_TEAM_ID_CHECK=1` 以略過檢查。

## 使用方式

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Ad-hoc 簽署注意事項

When signing with `SIGN_IDENTITY="-"` (ad-hoc), the script automatically disables the **Hardened Runtime** (`--options runtime`). 這是為了防止應用程式嘗試載入不共用相同 Team ID 的內嵌框架（例如 Sparkle）時發生當機。 Ad-hoc signatures also break TCC permission persistence; see [macOS permissions](/platforms/mac/permissions) for recovery steps.

## About 的建置中繼資料

`package-mac-app.sh` 會為套件加蓋以下資訊：

- `OpenClawBuildTimestamp`：封裝時間的 ISO8601 UTC
- `OpenClawGitCommit`：短 git 雜湊（若不可用則為 `unknown`）

「關於」分頁會讀取這些鍵值，以顯示版本、建置日期、git 提交，以及是否為除錯組建（透過 `#if DEBUG`）。在程式碼變更後，請重新執行封裝工具以更新這些值。 Run the packager to refresh these values after code changes.

## 原因

TCC 權限同時綁定於套件識別碼 _以及_ 程式碼簽章。 Unsigned debug builds with changing UUIDs were causing macOS to forget grants after each rebuild. Signing the binaries (ad‑hoc by default) and keeping a fixed bundle id/path (`dist/OpenClaw.app`) preserves the grants between builds, matching the VibeTunnel approach.
