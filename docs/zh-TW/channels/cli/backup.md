---
summary: CLI reference for `openclaw backup` (create local backup archives)
read_when:
  - You want a first-class backup archive for local OpenClaw state
  - You want to preview which paths would be included before reset or uninstall
title: backup
---

# `openclaw backup`

建立 OpenClaw 狀態、設定、憑證、會話的本地備份檔案，並可選擇性地備份工作區。

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
```

## Notes

- 此檔案包含一個 `manifest.json` 檔案，裡面有已解析的來源路徑和檔案結構。
- 預設輸出為當前工作目錄中的一個帶有時間戳的 `.tar.gz` 檔案。
- 如果當前工作目錄位於已備份的來源樹中，OpenClaw 將回退到您的主目錄作為預設的檔案位置。
- 現有的檔案不會被覆蓋。
- 為了避免自我包含，來源狀態/工作區樹中的輸出路徑會被拒絕。
- `openclaw backup verify <archive>` 驗證檔案是否包含恰好一個根清單，拒絕遍歷式的檔案路徑，並檢查每個清單聲明的有效負載是否存在於壓縮檔中。
- `openclaw backup create --verify` 在寫入檔案後立即執行該驗證。
- `openclaw backup create --only-config` 僅備份當前的 JSON 設定檔案。

## 什麼會被備份

`openclaw backup create` 計劃從您本地的 OpenClaw 安裝備份來源：

- OpenClaw 的本地狀態解析器返回的狀態目錄，通常是 `~/.openclaw`
- 活動設定檔的路徑
- OAuth / 憑證目錄
- 從當前設定中發現的工作區目錄，除非您傳遞 `--no-include-workspace`

如果您使用 `--only-config`，OpenClaw 將跳過狀態、憑證和工作區的發現，並僅存檔當前的設定檔路徑。

OpenClaw 在建立檔案庫之前會標準化路徑。如果設定、憑證或工作區已經存在於狀態目錄中，則不會將它們重複作為單獨的頂層備份來源。缺失的路徑將被跳過。

該檔案負載儲存來自這些來源樹的檔案內容，而嵌入的 `manifest.json` 記錄了解析後的絕對來源路徑以及每個資產所使用的檔案佈局。

## 無效設定行為

`openclaw backup` 故意繞過正常的設定預檢，以便在恢復過程中仍然能提供幫助。因為工作區發現依賴於有效的設定，`openclaw backup create` 現在在設定檔存在但無效且工作區備份仍然啟用的情況下，會快速失敗。

如果您在那種情況下仍然想要部分備份，請重新執行：

```bash
openclaw backup create --no-include-workspace
```

這樣可以保持狀態、設定和憑證在範圍內，同時完全跳過工作區的發現。

如果您只需要設定檔案本身的副本，`--only-config` 在設定檔案格式錯誤時也能正常運作，因為它不依賴於解析設定來進行工作區的發現。

## 大小與性能

OpenClaw 不強制執行內建的最大備份大小或每個檔案大小限制。

實際限制來自於本地機器和目標檔案系統：

- 可用空間用於臨時檔案寫入以及最終檔案
- 遍歷大型工作區樹並將其壓縮成 `.tar.gz` 的時間
- 如果使用 `openclaw backup create --verify` 或執行 `openclaw backup verify`，重新掃描檔案的時間
- 目標路徑的檔案系統行為。OpenClaw 偏好不覆寫的硬連結發佈步驟，當硬連結不被支援時則回退到獨佔複製

大型工作區通常是檔案大小的主要原因。如果您想要更小或更快的備份，請使用 `--no-include-workspace`。

對於最小的檔案，請使用 `--only-config`。
