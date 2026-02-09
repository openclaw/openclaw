---
summary: "「openclaw update」的 CLI 參考（相對安全的來源更新 + Gateway 閘道器自動重新啟動）"
read_when:
  - 當你想要安全地更新來源檢出時
  - 當你需要了解「--update」的簡寫行為時
title: "update"
---

# `openclaw update`

安全地更新 OpenClaw，並在 stable / beta / dev 頻道之間切換。

如果你是透過 **npm/pnpm** 安裝（全域安裝，沒有 git 中繼資料），更新會依照套件管理器流程進行，請參閱 [Updating](/install/updating)。

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

- `--no-restart`：成功更新後略過重新啟動 Gateway 服務。
- `--channel <stable|beta|dev>`：設定更新頻道（git + npm；會儲存在設定中）。
- `--tag <dist-tag|version>`：僅針對本次更新覆寫 npm dist-tag 或版本。
- `--json`：輸出可供機器讀取的 `UpdateRunResult` JSON。
- `--timeout <seconds>`：每個步驟的逾時時間（預設為 1200 秒）。

注意：降版需要確認，因為較舊的版本可能會破壞設定。

## `update status`

顯示目前啟用的更新頻道，以及 git 標籤 / 分支 / SHA（適用於來源檢出），並顯示是否有可用更新。

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options：

- `--json`：輸出可供機器讀取的狀態 JSON。
- `--timeout <seconds>`：檢查的逾時時間（預設為 3 秒）。

## `update wizard`

36. 互動式流程，用於選擇更新通道並確認更新後是否重新啟動 Gateway（預設為重新啟動）。 37. 若你選擇 `dev` 但沒有 git 檢出，
    它會提供建立一個。

## What it does

當你明確切換頻道（`--channel ...`）時，OpenClaw 也會維持
安裝方式的一致性：

- `dev` → 確保存在 git 檢出（預設：`~/openclaw`，可用 `OPENCLAW_GIT_DIR` 覆寫），
  更新後，並從該檢出安裝全域 CLI。
- `stable`/`beta` → 使用對應的 dist-tag 從 npm 安裝。

## Git checkout flow

頻道：

- `stable`：檢出最新的非 beta 標籤，然後建置 + doctor。
- `beta`：檢出最新的 `-beta` 標籤，然後建置 + doctor。
- `dev`：檢出 `main`，然後 fetch + rebase。

高階流程：

1. 需要乾淨的工作樹（沒有未提交的變更）。
2. 切換到所選的頻道（標籤或分支）。
3. 38. 取得上游更新（僅 dev）。
4. 僅 dev：在暫存工作樹中進行 lint 與 TypeScript 建置的預檢；如果目前提交失敗，會往回最多 10 個提交，找出最新可成功建置的版本。
5. 39. 重新基底到所選提交（僅 dev）。
6. 安裝相依套件（優先使用 pnpm；後備為 npm）。
7. 建置，並建置 Control UI。
8. 執行 `openclaw doctor`，作為最終的「安全更新」檢查。
9. 將外掛同步至目前啟用的頻道（dev 使用隨附的擴充；stable / beta 使用 npm），並更新以 npm 安裝的外掛。

## `--update` shorthand

`openclaw --update` 會重寫為 `openclaw update`（對於 shell 與啟動器腳本很實用）。

## See also

- `openclaw doctor`（在 git 檢出時，會提供先執行 update 的選項）
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
