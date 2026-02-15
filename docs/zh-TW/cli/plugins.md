---
summary: "`openclaw plugins` 的 CLI 參考文件（列表、安裝、解除安裝、啟用/停用、檢查）"
read_when:
  - 當你想安裝或管理程序內（in-process）的 Gateway 外掛程式時
  - 當你想對外掛程式載入失敗進行偵錯時
title: "plugins"
---

# `openclaw plugins`

管理 Gateway 外掛程式/擴展功能（以程序內方式載入）。

相關資訊：

- 外掛程式系統：[Plugins](/tools/plugin)
- 外掛程式資訊清單（manifest）與結構描述（schema）：[Plugin manifest](/plugins/manifest)
- 安全強化：[Security](/gateway/security)

## Commands

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins uninstall <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

隨附外掛程式會隨 OpenClaw 一併提供，但初始狀態為停用。請使用 `plugins enable` 來啟用它們。

所有外掛程式都必須隨附一個 `openclaw.plugin.json` 檔案，其中包含內嵌的 JSON Schema（`configSchema`，即使內容為空也需提供）。遺失或無效的資訊清單或結構描述將導致外掛程式無法載入，且無法通過設定驗證。

### Install

```bash
openclaw plugins install <path-or-spec>
```

安全注意事項：請像對待執行程式碼一樣謹慎處理外掛程式安裝。建議優先選用固定版本（pinned versions）。

支援的封存格式：`.zip`、`.tgz`、`.tar.gz`、`.tar`。

使用 `--link` 以避免複製本地目錄（會將路徑新增至 `plugins.load.paths`）：

```bash
openclaw plugins install -l ./my-plugin
```

### Uninstall

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` 會從 `plugins.entries`、`plugins.installs`、外掛程式白名單以及（若適用）連結的 `plugins.load.paths` 項目中移除外掛程式紀錄。對於使用中的記憶體外掛程式，記憶體插槽將重設為 `memory-core`。

預設情況下，解除安裝也會移除位於活動狀態目錄擴展根目錄（`$OPENCLAW_STATE_DIR/extensions/<id>`）下的外掛程式安裝目錄。使用 `--keep-files` 可保留磁碟上的檔案。

`--keep-config` 作為 `--keep-files` 的棄用別名仍受支援。

### Update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

更新僅適用於從 npm 安裝的外掛程式（記錄於 `plugins.installs` 中）。
