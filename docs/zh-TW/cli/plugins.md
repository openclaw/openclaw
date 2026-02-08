---
summary: "「openclaw plugins」（清單、安裝、啟用／停用、doctor）的 CLI 參考"
read_when:
  - 你想要安裝或管理行程內的 Gateway 閘道器 外掛
  - 你想要偵錯外掛載入失敗
title: "plugins"
x-i18n:
  source_path: cli/plugins.md
  source_hash: 60476e0a9b7247bd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:23Z
---

# `openclaw plugins`

管理 Gateway 閘道器 外掛／延伸功能（於行程內載入）。

相關內容：

- 外掛系統：[Plugins](/tools/plugin)
- 外掛資訊清單與結構描述：[Plugin manifest](/plugins/manifest)
- 安全性強化：[Security](/gateway/security)

## Commands

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

隨 OpenClaw 一同提供的內建外掛預設為停用。請使用 `plugins enable` 來
啟用它們。

所有外掛都必須提供一個 `openclaw.plugin.json` 檔案，並包含內嵌的 JSON Schema
（`configSchema`，即使為空）。缺少或無效的資訊清單或結構描述，會導致
外掛無法載入，且設定驗證失敗。

### Install

```bash
openclaw plugins install <path-or-spec>
```

安全性注意事項：請將外掛安裝視同執行程式碼。建議優先使用已固定版本。

支援的封存格式：`.zip`、`.tgz`、`.tar.gz`、`.tar`。

使用 `--link` 可避免複製本機目錄（會加入至 `plugins.load.paths`）：

```bash
openclaw plugins install -l ./my-plugin
```

### Update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

更新僅適用於從 npm 安裝的外掛（追蹤於 `plugins.installs`）。
