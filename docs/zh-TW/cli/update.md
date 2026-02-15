---
summary: "用於 `openclaw update` 的 CLI 參考文件（較安全的原始碼更新 + Gateway 自動重啟）"
read_when:
  - 當您想要安全地更新原始碼簽出（source checkout）時
  - 當您需要了解 `--update` 捷徑行為時
title: "update"
---

# `openclaw update`

安全地更新 OpenClaw，並在 stable、beta 與 dev 頻道之間切換。

如果您是透過 **npm/pnpm** 安裝（全域安裝，無 git 中繼資料），更新將透過 [更新](/install/updating) 中的套件管理員流程進行。

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`：更新成功後跳過重啟 Gateway 服務。
- `--channel <stable|beta|dev>`：設定更新頻道（git + npm；會永久儲存於設定中）。
- `--tag <dist-tag|version>`：僅針對此次更新覆蓋 npm dist-tag 或版本。
- `--json`：列印機器可讀的 `UpdateRunResult` JSON。
- `--timeout <seconds>`：每一步驟的逾時時間（預設為 1200 秒）。

注意：版本降級需要確認，因為舊版本可能會導致設定損壞。

## `update status`

顯示目前作用中的更新頻道 + git 標籤/分支/SHA（適用於原始碼簽出），以及可用的更新資訊。

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`：列印機器可讀的狀態 JSON。
- `--timeout <seconds>`：檢查的逾時時間（預設為 3 秒）。

## `update wizard`

互動式流程，可讓您選擇更新頻道並確認更新後是否重啟 Gateway（預設為重啟）。如果您在沒有 git 簽出的情況下選擇 `dev`，系統會詢問是否要建立一個。

## What it does

當您明確切換頻道（`--channel ...`）時，OpenClaw 也會保持安裝方式一致：

- `dev` → 確保有 git 簽出（預設：`~/openclaw`，可使用 `OPENCLAW_GIT_DIR` 覆蓋），對其進行更新，並從該簽出安裝全域 CLI。
- `stable`/`beta` → 使用相對應的 dist-tag 從 npm 安裝。

## Git checkout flow

頻道：

- `stable`：簽出最新的非 beta 標籤，然後執行建置 (build) + doctor。
- `beta`：簽出最新的 `-beta` 標籤，然後執行建置 + doctor。
- `dev`：簽出 `main`，然後執行 fetch + rebase。

高階流程：

1. 需要乾淨的工作樹（無未提交的變更）。
2. 切換至所選頻道（標籤或分支）。
3. 擷取遠端（upstream）變更（僅限 dev）。
4. 僅限 dev：在暫存工作樹中預先執行 lint + TypeScript 建置；如果最新版本失敗，會回溯最多 10 個提交來尋找最新的可用建置。
5. 衍合（Rebase）至所選提交（僅限 dev）。
6. 安裝相依項目（優先使用 pnpm；若無則使用 npm）。
7. 進行建置 + 建置 Control UI。
8. 執行 `openclaw doctor` 作為最後的「安全更新」檢查。
9. 同步外掛程式至作用中的頻道（dev 使用內建擴充功能；stable/beta 使用 npm），並更新透過 npm 安裝的外掛程式。

## `--update` shorthand

`openclaw --update` 會重寫為 `openclaw update`（對 shell 和啟動指令碼很有用）。

## See also

- `openclaw doctor`（在 git 簽出中會建議先執行更新）
- [開發頻道](/install/development-channels)
- [更新](/install/updating)
- [CLI 參考文件](/cli)
