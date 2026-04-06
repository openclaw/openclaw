---
read_when:
    - エージェントフックを管理したい場合
    - フックの利用可否を確認したい、またはワークスペースフックを有効にしたい場合
summary: '`openclaw hooks`（エージェントフック）のCLIリファレンス'
title: hooks
x-i18n:
    generated_at: "2026-04-02T07:34:09Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 07d53b837355117444176becd1c70623e2040edc6f524e7b65619a9700dcceb3
    source_path: cli/hooks.md
    workflow: 15
---

# `openclaw hooks`

エージェントフック（`/new`、`/reset`、Gateway ゲートウェイ起動などのコマンドに対するイベント駆動の自動化）を管理します。

関連:

- フック: [フック](/automation/hooks)
- プラグインフック: [プラグインフック](/plugins/architecture#provider-runtime-hooks)

## すべてのフックを一覧表示

```bash
openclaw hooks list
```

ワークスペース、マネージド、追加、バンドルの各ディレクトリから検出されたすべてのフックを一覧表示します。

**オプション:**

- `--eligible`: 要件を満たしている適格なフックのみ表示
- `--json`: JSON形式で出力
- `-v, --verbose`: 不足している要件を含む詳細情報を表示

**出力例:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📎 bootstrap-extra-files ✓ - Inject extra workspace bootstrap files during agent bootstrap
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new or /reset command is issued
```

**例（verbose）:**

```bash
openclaw hooks list --verbose
```

不適格なフックの不足要件を表示します。

**例（JSON）:**

```bash
openclaw hooks list --json
```

プログラムでの利用向けに構造化されたJSONを返します。

## フック情報の取得

```bash
openclaw hooks info <name>
```

特定のフックに関する詳細情報を表示します。

**引数:**

- `<name>`: フック名（例: `session-memory`）

**オプション:**

- `--json`: JSON形式で出力

**例:**

```bash
openclaw hooks info session-memory
```

**出力:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new or /reset command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/automation/hooks#session-memory
  Events: command:new, command:reset

Requirements:
  Config: ✓ workspace.dir
```

## フックの適格性チェック

```bash
openclaw hooks check
```

フックの適格性ステータスの概要（準備完了と未準備の数）を表示します。

**オプション:**

- `--json`: JSON形式で出力

**出力例:**

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

設定（`~/.openclaw/config.json`）に追加して、特定のフックを有効にします。

**注意:** ワークスペースフックは、ここまたは設定で有効にするまでデフォルトで無効です。プラグインが管理するフックは `openclaw hooks list` で `plugin:<id>` と表示され、ここでは有効化/無効化できません。代わりにプラグインを有効化/無効化してください。

**引数:**

- `<name>`: フック名（例: `session-memory`）

**例:**

```bash
openclaw hooks enable session-memory
```

**出力:**

```
✓ Enabled hook: 💾 session-memory
```

**動作内容:**

- フックが存在し適格かどうかを確認
- 設定内の `hooks.internal.entries.<name>.enabled = true` を更新
- 設定をディスクに保存

フックが `<workspace>/hooks/` から取得されたものの場合、Gateway ゲートウェイが
読み込む前にこのオプトインステップが必要です。

**有効化後:**

- フックが再読み込みされるようにGateway ゲートウェイを再起動してください（macOSではメニューバーアプリの再起動、開発環境ではGateway ゲートウェイプロセスの再起動）。

## フックの無効化

```bash
openclaw hooks disable <name>
```

設定を更新して、特定のフックを無効にします。

**引数:**

- `<name>`: フック名（例: `command-logger`）

**例:**

```bash
openclaw hooks disable command-logger
```

**出力:**

```
⏸ Disabled hook: 📝 command-logger
```

**無効化後:**

- フックが再読み込みされるようにGateway ゲートウェイを再起動してください

## フックパックのインストール

```bash
openclaw plugins install <package>        # ClawHub優先、次にnpm
openclaw plugins install <package> --pin  # バージョンを固定
openclaw plugins install <path>           # ローカルパス
```

統合プラグインインストーラーを通じてフックパックをインストールします。

`openclaw hooks install` は互換性エイリアスとして引き続き動作しますが、非推奨の
警告を表示し、`openclaw plugins install` に転送します。

npm指定は**レジストリのみ**（パッケージ名 + オプションの**正確なバージョン**または
**dist-tag**）です。Git/URL/ファイル指定およびセマンティックバージョニング範囲は拒否されます。依存関係のインストールは安全のため `--ignore-scripts` で実行されます。

ベア指定と `@latest` はstableトラックに留まります。npmがそれらのいずれかを
プレリリースに解決した場合、OpenClawは停止し、`@beta`/`@rc` などのプレリリースタグ
または正確なプレリリースバージョンで明示的にオプトインするよう求めます。

**動作内容:**

- フックパックを `~/.openclaw/hooks/<id>` にコピー
- `hooks.internal.entries.*` でインストールされたフックを有効化
- `hooks.internal.installs` にインストールを記録

**オプション:**

- `-l, --link`: コピーする代わりにローカルディレクトリをリンク（`hooks.internal.load.extraDirs` に追加）
- `--pin`: npmインストールを `hooks.internal.installs` に正確に解決された `name@version` として記録

**サポートされるアーカイブ:** `.zip`、`.tgz`、`.tar.gz`、`.tar`

**例:**

```bash
# ローカルディレクトリ
openclaw plugins install ./my-hook-pack

# ローカルアーカイブ
openclaw plugins install ./my-hook-pack.zip

# NPMパッケージ
openclaw plugins install @openclaw/my-hook-pack

# コピーせずにローカルディレクトリをリンク
openclaw plugins install -l ./my-hook-pack
```

リンクされたフックパックは、ワークスペースフックとしてではなく、オペレーターが
設定したディレクトリからのマネージドフックとして扱われます。

## フックパックの更新

```bash
openclaw plugins update <id>
openclaw plugins update --all
```

統合プラグインアップデーターを通じて、追跡中のnpmベースのフックパックを更新します。

`openclaw hooks update` は互換性エイリアスとして引き続き動作しますが、非推奨の
警告を表示し、`openclaw plugins update` に転送します。

**オプション:**

- `--all`: 追跡中のすべてのフックパックを更新
- `--dry-run`: 書き込みせずに変更内容を表示

保存済みの整合性ハッシュが存在し、取得したアーティファクトのハッシュが変更された場合、
OpenClawは警告を表示し、続行前に確認を求めます。CI/非対話実行では
グローバル `--yes` を使用してプロンプトをバイパスしてください。

## バンドルされたフック

### session-memory

`/new` または `/reset` を実行した際に、セッションコンテキストをメモリに保存します。

**有効化:**

```bash
openclaw hooks enable session-memory
```

**出力先:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**参照:** [session-memoryドキュメント](/automation/hooks#session-memory)

### bootstrap-extra-files

`agent:bootstrap` 中に追加のブートストラップファイル（例: モノレポローカルの `AGENTS.md` / `TOOLS.md`）をインジェクションします。

**有効化:**

```bash
openclaw hooks enable bootstrap-extra-files
```

**参照:** [bootstrap-extra-filesドキュメント](/automation/hooks#bootstrap-extra-files)

### command-logger

すべてのコマンドイベントを一元的な監査ファイルに記録します。

**有効化:**

```bash
openclaw hooks enable command-logger
```

**出力先:** `~/.openclaw/logs/commands.log`

**ログの表示:**

```bash
# 最近のコマンド
tail -n 20 ~/.openclaw/logs/commands.log

# 整形表示
cat ~/.openclaw/logs/commands.log | jq .

# アクションでフィルタ
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**参照:** [command-loggerドキュメント](/automation/hooks#command-logger)

### boot-md

Gateway ゲートウェイの起動時（チャネル開始後）に `BOOT.md` を実行します。

**イベント**: `gateway:startup`

**有効化**:

```bash
openclaw hooks enable boot-md
```

**参照:** [boot-mdドキュメント](/automation/hooks#boot-md)
