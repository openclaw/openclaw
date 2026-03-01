---
summary: "`openclaw hooks` のCLIリファレンス（エージェントフック）"
read_when:
  - エージェントフックを管理したい場合
  - フックをインストールまたは更新したい場合
title: "hooks"
---

# `openclaw hooks`

エージェントフック（`/new`、`/reset`、Gatewayの起動などのコマンドに対するイベント駆動のオートメーション）を管理します。

関連：

- フック：[Hooks](/automation/hooks)
- プラグインフック：[Plugins](/tools/plugin#plugin-hooks)

## 全フックの一覧

```bash
openclaw hooks list
```

ワークスペース、マネージド、およびバンドルされたディレクトリから発見されたすべてのフックを一覧表示します。

**オプション：**

- `--eligible`: 適格なフック（要件を満たしているもの）のみ表示
- `--json`: JSON形式で出力
- `-v, --verbose`: 不足している要件を含む詳細情報を表示

**出力例：**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📎 bootstrap-extra-files ✓ - Inject extra workspace bootstrap files during agent bootstrap
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
```

**使用例（詳細表示）：**

```bash
openclaw hooks list --verbose
```

不適格なフックの不足している要件を表示します。

**使用例（JSON）：**

```bash
openclaw hooks list --json
```

プログラム的な使用のための構造化JSONを返します。

## フック情報の取得

```bash
openclaw hooks info <name>
```

特定のフックの詳細情報を表示します。

**引数：**

- `<name>`: フック名（例：`session-memory`）

**オプション：**

- `--json`: JSON形式で出力

**使用例：**

```bash
openclaw hooks info session-memory
```

**出力：**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/automation/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## フック適格性の確認

```bash
openclaw hooks check
```

フックの適格性ステータスの概要（準備完了と未準備の数）を表示します。

**オプション：**

- `--json`: JSON形式で出力

**出力例：**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## フックの有効化

```bash
openclaw hooks enable <name>
```

特定のフックを設定（`~/.openclaw/config.json`）に追加して有効化します。

**注意：** プラグインによって管理されているフックは `openclaw hooks list` で `plugin:<id>` と表示され、ここでは有効化/無効化できません。代わりにプラグインを有効化/無効化してください。

**引数：**

- `<name>`: フック名（例：`session-memory`）

**使用例：**

```bash
openclaw hooks enable session-memory
```

**出力：**

```
✓ Enabled hook: 💾 session-memory
```

**動作内容：**

- フックが存在し適格であるか確認します
- 設定の `hooks.internal.entries.<name>.enabled = true` を更新します
- 設定をディスクに保存します

**有効化後：**

- フックがリロードされるようにGatewayを再起動してください（macOSではメニューバーアプリの再起動、開発時はGatewayプロセスの再起動）。

## フックの無効化

```bash
openclaw hooks disable <name>
```

設定を更新して特定のフックを無効化します。

**引数：**

- `<name>`: フック名（例：`command-logger`）

**使用例：**

```bash
openclaw hooks disable command-logger
```

**出力：**

```
⏸ Disabled hook: 📝 command-logger
```

**無効化後：**

- フックがリロードされるようにGatewayを再起動してください

## フックのインストール

```bash
openclaw hooks install <path-or-spec>
openclaw hooks install <npm-spec> --pin
```

ローカルフォルダー/アーカイブまたはnpmからフックパックをインストールします。

npm指定は**レジストリのみ**（パッケージ名 + オプションのバージョン/タグ）です。Git/URL/ファイル指定は拒否されます。依存関係のインストールは安全のため `--ignore-scripts` で実行されます。

**動作内容：**

- フックパックを `~/.openclaw/hooks/<id>` にコピーします
- インストールされたフックを `hooks.internal.entries.*` で有効化します
- インストールを `hooks.internal.installs` に記録します

**オプション：**

- `-l, --link`: コピーする代わりにローカルディレクトリをリンクします（`hooks.internal.load.extraDirs` に追加）
- `--pin`: npmインストールを `hooks.internal.installs` に正確に解決された `name@version` として記録します

**サポートされるアーカイブ：** `.zip`、`.tgz`、`.tar.gz`、`.tar`

**使用例：**

```bash
# ローカルディレクトリ
openclaw hooks install ./my-hook-pack

# ローカルアーカイブ
openclaw hooks install ./my-hook-pack.zip

# NPMパッケージ
openclaw hooks install @openclaw/my-hook-pack

# コピーせずにローカルディレクトリをリンク
openclaw hooks install -l ./my-hook-pack
```

## フックの更新

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

インストール済みフックパック（npmインストールのみ）を更新します。

**オプション：**

- `--all`: 追跡されている全フックパックを更新
- `--dry-run`: 書き込みせずに変更内容を表示

保存された整合性ハッシュが存在し、取得したアーティファクトのハッシュが変更された場合、OpenClawは警告を表示し、続行前に確認を求めます。CI/非対話実行ではグローバル `--yes` を使用してプロンプトをバイパスできます。

## バンドルされたフック

### session-memory

`/new` を発行した際にセッションコンテキストをメモリに保存します。

**有効化：**

```bash
openclaw hooks enable session-memory
```

**出力：** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**参照：** [session-memory documentation](/automation/hooks#session-memory)

### bootstrap-extra-files

`agent:bootstrap` 中に追加のブートストラップファイル（例：モノレポローカルの `AGENTS.md` / `TOOLS.md`）を注入します。

**有効化：**

```bash
openclaw hooks enable bootstrap-extra-files
```

**参照：** [bootstrap-extra-files documentation](/automation/hooks#bootstrap-extra-files)

### command-logger

すべてのコマンドイベントを一元化された監査ファイルにログ出力します。

**有効化：**

```bash
openclaw hooks enable command-logger
```

**出力：** `~/.openclaw/logs/commands.log`

**ログの確認：**

```bash
# 最近のコマンド
tail -n 20 ~/.openclaw/logs/commands.log

# 整形表示
cat ~/.openclaw/logs/commands.log | jq .

# アクションでフィルター
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**参照：** [command-logger documentation](/automation/hooks#command-logger)

### boot-md

Gateway起動時（チャネル起動後）に `BOOT.md` を実行します。

**イベント**: `gateway:startup`

**有効化**:

```bash
openclaw hooks enable boot-md
```

**参照：** [boot-md documentation](/automation/hooks#boot-md)
