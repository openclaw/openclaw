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

安全更新 OpenClaw 並在穩定版、測試版與開發版頻道間切換。

如果你是透過 **npm/pnpm**（全域安裝，無 git 元資料）安裝，更新將透過套件管理流程進行，詳見 [Updating](/install/updating)。

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

## 選項

- `--no-restart`：成功更新後跳過重新啟動 Gateway 服務。
- `--channel <stable|beta|dev>`：設定更新頻道（git + npm；會保存在設定檔中）。
- `--tag <dist-tag|version>`：僅針對本次更新覆寫 npm dist-tag 或版本。
- `--dry-run`：預覽計畫中的更新動作（頻道/標籤/目標/重啟流程），不會寫入設定檔、安裝、同步外掛或重啟。
- `--json`：輸出機器可讀的 `UpdateRunResult` JSON。
- `--timeout <seconds>`：每步驟逾時時間（預設為 1200 秒）。

注意：降級需要確認，因為舊版本可能會破壞設定。

## `update status`

顯示目前使用的更新頻道 + git 標籤/分支/SHA（針對原始碼檢出），以及更新可用性。

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

選項：

- `--json`：輸出機器可讀的狀態 JSON。
- `--timeout <seconds>`：檢查逾時時間（預設為 3 秒）。

## `update wizard`

互動式流程，選擇更新頻道並確認更新後是否重新啟動 Gateway（預設為重新啟動）。如果你選擇 `dev`，但尚未有 git 檢出，系統會提供建立檢出的選項。

## 功能說明

當你明確切換頻道 (`--channel ...`) 時，OpenClaw 也會保持安裝方式的一致性：

- `dev` → 確保執行 git checkout（預設為 `~/openclaw`，可用 `OPENCLAW_GIT_DIR` 覆寫），
  並更新它，然後從該 checkout 安裝全域 CLI。
- `stable`/`beta` → 使用相符的 dist-tag 從 npm 安裝。

Gateway 核心自動更新器（透過設定啟用時）會重複使用相同的更新流程。

## Git checkout 流程

頻道：

- `stable`：checkout 最新的非 beta 標籤，然後執行 build + doctor。
- `beta`：checkout 最新的 `-beta` 標籤，然後執行 build + doctor。
- `dev`：checkout `main`，然後 fetch + rebase。

高階流程：

1. 需要乾淨的工作樹（無未提交的變更）。
2. 切換到選定的頻道（標籤或分支）。
3. 取得上游更新（僅限開發）。
4. 僅限開發：在臨時工作樹執行 preflight lint + TypeScript build；若最新提交失敗，則往回最多 10 個 commit 找出最新可用的乾淨 build。
5. 以選定的 commit 進行 rebase（僅限開發）。
6. 安裝相依套件（優先使用 pnpm；失敗則退回 npm）。
7. 執行 build 並建置 Control UI。
8. 執行 `openclaw doctor` 作為最終的「安全更新」檢查。
9. 同步插件至目前頻道（開發頻道使用內建擴充套件；穩定/測試頻道使用 npm），並更新 npm 安裝的插件。

## `--update` 簡寫

`openclaw --update` 會重寫為 `openclaw update`（對 shell 和啟動器腳本很有用）。

## 參考資料

- `openclaw doctor`（提供在 git checkout 時先執行更新的選項）
- [開發頻道](/install/development-channels)
- [更新說明](/install/updating)
- [CLI 參考](/cli)
