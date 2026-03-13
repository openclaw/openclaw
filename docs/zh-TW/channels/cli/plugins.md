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

管理閘道插件/擴充（在過程中加載）。

[[BLOCK_1]]

- 外掛系統: [Plugins](/tools/plugin)
- 外掛清單 + 架構: [Plugin manifest](/plugins/manifest)
- 安全性強化: [Security](/gateway/security)

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

Bundled plugins 隨 OpenClaw 一起提供，但預設為禁用。使用 `plugins enable` 來啟用它們。

所有插件必須隨附一個 `openclaw.plugin.json` 檔案，並包含內嵌的 JSON Schema (`configSchema`，即使是空的)。缺少或無效的清單或架構會阻止插件加載並使設定驗證失敗。

### 安裝

```bash
openclaw plugins install <path-or-spec>
openclaw plugins install <npm-spec> --pin
```

安全提示：將插件安裝視為執行程式碼。建議使用固定版本。

Npm 規格是 **僅限於註冊表**（套件名稱 + 可選的 **確切版本** 或 **dist-tag**）。Git/URL/檔案規格和 semver 範圍會被拒絕。依賴安裝以 `--ignore-scripts` 進行，以確保安全。

Bare specs 和 `@latest` 會保持在穩定的路徑上。如果 npm 將其中任何一個解析為預發行版本，OpenClaw 會停止並要求您明確選擇加入，使用預發行標籤，例如 `@beta`/`@rc` 或者精確的預發行版本，例如 `@1.2.3-beta.4`。

如果裸安裝規格與捆綁插件 ID 匹配（例如 `diffs`），OpenClaw 將直接安裝捆綁插件。要安裝具有相同名稱的 npm 套件，請使用明確的範圍規格（例如 `@scope/diffs`）。

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

使用 `--link` 來避免複製本地目錄（會新增到 `plugins.load.paths`）：

```bash
openclaw plugins install -l ./my-plugin
```

在 npm 安裝時使用 `--pin` 來將解析的確切規範 (`name@version`) 儲存在 `plugins.installs` 中，同時保持預設行為不固定。

### 卸載

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` 從 `plugins.entries`、`plugins.installs`、插件允許清單以及相關的 `plugins.load.paths` 條目中移除插件記錄（如適用）。對於活躍的記憶體插件，記憶體槽重置為 `memory-core`。

預設情況下，卸載也會移除活躍狀態目錄擴充根目錄下的插件安裝目錄 (`$OPENCLAW_STATE_DIR/extensions/<id>`)。使用 `--keep-files` 可以保留磁碟上的檔案。

`--keep-config` 被支援作為 `--keep-files` 的已過時別名。

### Update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

更新僅適用於從 npm 安裝的插件（在 `plugins.installs` 中追蹤）。

當存在已儲存的完整性雜湊且擷取的工件雜湊發生變更時，OpenClaw 會印出警告並要求確認後再繼續。使用全域 `--yes` 來在 CI/非互動式執行中跳過提示。
