---
summary: "CLI 參考資料 `openclaw update`（相對安全的原始碼更新 + Gateway 自動重新啟動）"
read_when:
  - 您想安全地更新原始碼檢查
  - 您需要了解 `--update` 簡寫行為
title: "update"
---

# `openclaw update`

安全地更新 OpenClaw 並在穩定版/測試版/開發版頻道之間切換。

如果您是透過 **npm/pnpm** 安裝（全域安裝，沒有 git 元資料），更新將透過[更新](/install/updating)中的套件管理器流程進行。

## 用法

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

## 選項

- `--no-restart`：成功更新後，跳過重新啟動 Gateway 服務。
- `--channel <stable|beta|dev>`：設定更新頻道（git + npm；儲存在設定中）。
- `--tag <dist-tag|version>`：僅針對本次更新，覆寫 npm dist-tag 或版本。
- `--json`：列印機器可讀的 `UpdateRunResult` JSON。
- `--timeout <seconds>`：每個步驟的逾時（預設為 1200 秒）。

注意：降級需要確認，因為舊版本可能會破壞設定。

## `update status`

顯示啟用中的更新頻道 + git 標籤/分支/SHA（用於原始碼檢查），以及更新可用性。

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

選項：

- `--json`：列印機器可讀的狀態 JSON。
- `--timeout <seconds>`：檢查的逾時（預設為 3 秒）。

## `update wizard`

互動式流程，用於選擇更新頻道並確認是否在更新後重新啟動 Gateway（預設為重新啟動）。如果您在沒有 git 檢查的情況下選擇 `dev`，它會提供建立一個。

## 作用

當您明確切換頻道（`--channel ...`）時，OpenClaw 也會保持安裝方法一致：

- `dev` → 確保 git 檢查（預設：`~/openclaw`，可使用 `OPENCLAW_GIT_DIR` 覆寫），更新它，並從該檢查安裝全域 CLI。
- `stable`/`beta` → 使用匹配的 dist-tag 從 npm 安裝。

## Git 檢查流程

頻道：

- `stable`：檢查最新的非測試版標籤，然後建構 + doctor。
- `beta`：檢查最新的 `-beta` 標籤，然後建構 + doctor。
- `dev`：檢查 `main`，然後 fetch + rebase。

高層次：

1. 需要乾淨的工作樹（沒有未提交的變更）。
2. 切換到選定的頻道（標籤或分支）。
3. Fetch 上游（僅限 dev）。
4. 僅限 dev：在臨時工作樹中進行預檢 lint + TypeScript 建構；如果 tip 失敗，則回溯最多 10 個提交以找到最新的乾淨建構。
5. Rebase 到選定的提交（僅限 dev）。
6. 安裝依賴項（首選 pnpm；npm 備用）。
7. 建構 + 建構 Control UI。
8. 執行 `openclaw doctor` 作為最終的「安全更新」檢查。
9. 將外掛同步到啟用中的頻道（dev 使用捆綁的擴充功能；stable/beta 使用 npm）並更新 npm 安裝的外掛。

## `--update` 簡寫

`openclaw --update` 會重寫為 `openclaw update`（對於 shell 和啟動器腳本很有用）。

## 參閱

- `openclaw doctor`（在 git 檢查時會先執行更新）
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
