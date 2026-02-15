---
summary: "openclaw plugins 的 CLI 參考 (列出、安裝、解除安裝、啟用/停用、診斷)"
read_when:
  - 當您想要安裝或管理程序內 Gateway 外掛程式時
  - 當您想要偵錯外掛程式載入失敗時
title: "外掛程式"
---

# `openclaw 外掛程式`

管理 Gateway 外掛程式/擴充功能 (程序內載入)。

相關：

- 外掛程式系統：[外掛程式](/tools/plugin)
- 外掛程式清單 + 結構描述：[外掛程式清單](/plugins/manifest)
- 安全性強化：[安全性](/gateway/security)

## 指令

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

OpenClaw 隨附的捆綁外掛程式預設為停用。使用 `plugins enable` 啟用它們。

所有外掛程式必須隨附一個 `openclaw.plugin.json` 檔案，其中包含內聯 JSON 結構描述 (`configSchema`，即使為空)。缺少/無效的清單或結構描述會導致外掛程式無法載入並使設定驗證失敗。

### 安裝

```bash
openclaw plugins install <path-or-spec>
```

安全注意事項：將外掛程式安裝視為執行程式碼。建議使用固定版本。

支援的封存格式：`.zip`、`.tgz`、`.tar.gz`、`.tar`。

使用 `--link` 避免複製本機目錄 (新增至 `plugins.load.paths`)：

```bash
openclaw plugins install -l ./my-plugin
```

### 解除安裝

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` 會從 `plugins.entries`、`plugins.installs`、外掛程式允許清單以及適用的連結 `plugins.load.paths` 項目中移除外掛程式記錄。對於啟用中的記憶體外掛程式，記憶體槽會重設為 `memory-core`。

依預設，解除安裝也會移除啟用中狀態目錄擴充功能根目錄 (`$OPENCLAW_STATE_DIR/extensions/<id>`) 下的外掛程式安裝目錄。使用 `--keep-files` 可保留磁碟上的檔案。

`--keep-config` 做為 `--keep-files` 的已棄用別名受到支援。

### 更新

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

更新僅適用於從 npm 安裝的外掛程式 (在 `plugins.installs` 中追蹤)。
