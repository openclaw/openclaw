---
summary: >-
  CLI reference for `openclaw update` (safe-ish source update + gateway
  auto-restart)
read_when:
  - You want to update a source checkout safely
  - You need to understand `--update` shorthand behavior
title: update
---

# `openclaw update`

安全地更新 OpenClaw 並在穩定/測試/開發頻道之間切換。

如果您是透過 **npm/pnpm** 安裝（全域安裝，沒有 git 元數據），則更新將透過 [更新](/install/updating) 中的套件管理流程進行。

## 使用方式

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --dry-run
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: 在成功更新後跳過重新啟動 Gateway 服務。
- `--channel <stable|beta|dev>`: 設定更新通道（git + npm；持久化於設定中）。
- `--tag <dist-tag|version>`: 僅針對此次更新覆蓋 npm 的 dist-tag 或版本。
- `--dry-run`: 預覽計劃中的更新操作（通道/標籤/目標/重新啟動流程），而不寫入設定、安裝、同步插件或重新啟動。
- `--json`: 輸出機器可讀的 `UpdateRunResult` JSON。
- `--timeout <seconds>`: 每步驟的超時設定（預設為 1200 秒）。

注意：降級需要確認，因為舊版本可能會破壞設定。

## `update status`

顯示活動更新通道 + git 標籤/分支/SHA（用於源程式碼檢出），以及更新可用性。

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

[[BLOCK_1]]

- `--json`: 列印機器可讀的狀態 JSON。
- `--timeout <seconds>`: 檢查的超時時間（預設為 3 秒）。

## `update wizard`

互動流程用於選擇更新通道並確認是否在更新後重新啟動 Gateway（預設為重新啟動）。如果您在未執行 git checkout 的情況下選擇 `dev`，系統會提供創建一個的選項。

## 它的功能

當您明確切換頻道 (`--channel ...`) 時，OpenClaw 也會保持安裝方法的一致性：

- `dev` → 確保進行 git checkout（預設值：`~/openclaw`，可用 `OPENCLAW_GIT_DIR` 覆蓋），更新它，並從該 checkout 安裝全域 CLI。
- `stable`/`beta` → 使用匹配的 dist-tag 從 npm 安裝。

Gateway 核心自動更新器（當透過設定啟用時）會重複使用這條相同的更新路徑。

## Git checkout 流程

Channels:

- `stable`: 檢出最新的非測試版標籤，然後進行建置 + 健康檢查。
- `beta`: 檢出最新的 `-beta` 標籤，然後進行建置 + 健康檢查。
- `dev`: 檢出 `main`，然後進行抓取 + 變基。

[[BLOCK_1]]

1. 需要一個乾淨的工作樹（沒有未提交的變更）。
2. 切換到選定的通道（標籤或分支）。
3. 獲取上游（僅限開發）。
4. 僅限開發：在臨時工作樹中進行預檢 lint + TypeScript 建置；如果最新的提交失敗，回溯最多 10 次提交以找到最新的乾淨建置。
5. 在選定的提交上進行 rebase（僅限開發）。
6. 安裝依賴（首選 pnpm；備用 npm）。
7. 建置 + 建置控制 UI。
8. 執行 `openclaw doctor` 作為最終的「安全更新」檢查。
9. 將插件同步到活動通道（開發使用捆綁的擴充；穩定/測試版使用 npm）並更新 npm 安裝的插件。

## `--update` 簡寫

`openclaw --update` 重新寫成 `openclaw update`（對於 shell 和啟動腳本很有用）。

## 另請參閱

- `openclaw doctor` (提供在 git 檢出時優先執行更新)
- [開發通道](/install/development-channels)
- [更新](/install/updating)
- [CLI 參考](/cli)
