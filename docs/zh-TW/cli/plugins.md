---
summary: >-
  CLI reference for `openclaw plugins` (list, install, uninstall,
  enable/disable, doctor)
read_when:
  - You want to install or manage in-process Gateway plugins
  - You want to debug plugin load failures
title: plugins
---

# `openclaw plugins`

管理 Gateway 外掛/擴充功能（於程序內載入）。

相關資訊：

- 外掛系統：[外掛](/tools/plugin)
- 外掛清單與結構：[外掛清單](/plugins/manifest)
- 安全強化：[安全](/gateway/security)

## 指令集

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

OpenClaw 內建的插件預設為停用狀態。請使用 `plugins enable` 來啟用它們。

所有插件必須附帶一個 `openclaw.plugin.json` 檔案，內含內嵌的 JSON Schema (`configSchema`，即使為空)。缺少或無效的清單或 Schema 會導致插件無法載入，並且設定驗證失敗。

### 安裝

```bash
openclaw plugins install <path-or-spec>
openclaw plugins install <npm-spec> --pin
```

安全注意事項：將外掛安裝視同執行程式碼。建議使用固定版本。

Npm 規格僅限於 **registry-only**（套件名稱 + 選擇性 **精確版本** 或 **dist-tag**）。拒絕 Git/URL/檔案規格及 semver 範圍。依賴安裝會以 `--ignore-scripts` 執行以確保安全。

裸規格與 `@latest` 保持在穩定版本路線。如果 npm 將其中任一解析為預發行版本，OpenClaw 會停止並要求你明確選擇使用預發行標籤，如 `@beta`/`@rc`，或精確的預發行版本，如 `@1.2.3-beta.4`。

如果裸安裝規格符合內建外掛 ID（例如 `diffs`），OpenClaw 會直接安裝該內建外掛。若要安裝同名的 npm 套件，請使用明確的作用域規格（例如 `@scope/diffs`）。

支援的壓縮檔格式：`.zip`、`.tgz`、`.tar.gz`、`.tar`。

使用 `--link` 來避免複製本地目錄（會加入到 `plugins.load.paths`）：

```bash
openclaw plugins install -l ./my-plugin
```

在 npm 安裝時使用 `--pin`，可將解析後的精確規格 (`name@version`) 儲存在 `plugins.installs`，同時保持預設行為不鎖定版本。

### 移除安裝

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` 會從 `plugins.entries`、`plugins.installs`、插件允許清單，以及相關的 `plugins.load.paths` 條目中移除插件紀錄（如適用）。對於正在使用中的記憶體插件，記憶體槽會重設為 `memory-core`。

預設情況下，解除安裝也會移除位於啟用狀態目錄擴充功能根目錄 (`$OPENCLAW_STATE_DIR/extensions/<id>`) 下的插件安裝目錄。使用 `--keep-files` 可保留磁碟上的檔案。

`--keep-config` 被支援作為 `--keep-files` 的已棄用別名。

### 更新

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

更新僅適用於從 npm 安裝的外掛（記錄於 `plugins.installs`）。

當存在已儲存的完整性雜湊且取得的檔案雜湊發生變更時，
OpenClaw 會顯示警告並要求確認後才繼續。使用全域 `--yes` 可在 CI/非互動式執行時跳過提示。
