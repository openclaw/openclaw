---
summary: "CLI 参照用の `openclaw hooks`（エージェント フック）"
read_when:
  - エージェント フックを管理したい場合
  - フックをインストールまたは更新したい場合
title: "フック"
---

# `openclaw hooks`

エージェント フック（`/new`、`/reset`、およびゲートウェイ起動などのコマンド向けのイベント駆動型自動化）を管理します。

関連:

- フック: [Hooks](/automation/hooks)
- プラグイン フック: [Plugins](/tools/plugin#plugin-hooks)

## すべてのフックを一覧表示

```bash
openclaw hooks list
```

ワークスペース、管理対象、バンドルされたディレクトリから検出されたすべてのフックを一覧表示します。

**オプション:**

- `--eligible`: 対象となるフックのみを表示（要件を満たしているもの）
- `--json`: JSON として出力
- `-v, --verbose`: 不足している要件を含む詳細情報を表示

**出力例:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**例（詳細）:**

```bash
openclaw hooks list --verbose
```

対象外のフックに対して不足している要件を表示します。

**例（JSON）:**

```bash
openclaw hooks list --json
```

プログラムでの利用向けに構造化された JSON を返します。

## フック情報を取得

```bash
openclaw hooks info <name>
```

特定のフックに関する詳細情報を表示します。

**引数:**

- `<name>`: フック名（例: `session-memory`）

**オプション:**

- `--json`: JSON として出力

**例:**

```bash
openclaw hooks info session-memory
```

**出力:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## フックの適格性を確認

```bash
openclaw hooks check
```

フックの適格性ステータスの要約（準備完了と未準備の数）を表示します。

**オプション:**

- `--json`: JSON として出力

**出力例:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## フックを有効化

```bash
openclaw hooks enable <name>
```

特定のフックを設定（`~/.openclaw/config.json`）に追加して有効化します。

**注記:** プラグインによって管理されるフックは、`openclaw hooks list` 内に `plugin:<id>` と表示され、
ここでは有効化／無効化できません。代わりにプラグインを有効化／無効化してください。 代わりにプラグインを有効/無効にします。

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

- フックが存在し、適格であるかを確認
- 設定内の `hooks.internal.entries.<name>.enabled = true` を更新
- 設定をディスクに保存

**有効化後:**

- フックを再読み込みするためにゲートウェイを再起動します（macOS のメニューバー アプリの再起動、または開発環境でのゲートウェイ プロセスの再起動）。

## フックを無効化

```bash
openclaw hooks disable <name>
```

設定を更新して特定のフックを無効化します。

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

- フックを再読み込みするためにゲートウェイを再起動します

## フックをインストール

```bash
openclaw hooks install <path-or-spec>
```

ローカル フォルダー／アーカイブ、または npm からフック パックをインストールします。

**動作内容:**

- フック パックを `~/.openclaw/hooks/<id>` にコピー
- インストールされたフックを `hooks.internal.entries.*` で有効化
- インストール内容を `hooks.internal.installs` に記録

**オプション:**

- `-l, --link`: コピーせずにローカル ディレクトリをリンク（`hooks.internal.load.extraDirs` に追加）

**対応アーカイブ:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**例:**

```bash
# Local directory
openclaw hooks install ./my-hook-pack

# Local archive
openclaw hooks install ./my-hook-pack.zip

# NPM package
openclaw hooks install @openclaw/my-hook-pack

# Link a local directory without copying
openclaw hooks install -l ./my-hook-pack
```

## フックを更新

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

インストール済みのフック パックを更新します（npm インストールのみ）。

**オプション:**

- `--all`: 追跡されているすべてのフック パックを更新
- `--dry-run`: 書き込みを行わず、変更内容のみを表示

## バンドルされたフック

### session-memory

`/new` を実行した際に、セッション コンテキストをメモリに保存します。

**有効化:**

```bash
openclaw hooks enable session-memory
```

**出力:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**参照:** [session-memory documentation](/automation/hooks#session-memory)

### command-logger

すべてのコマンド イベントを集中管理された監査ファイルに記録します。

**有効化:**

```bash
openclaw hooks enable command-logger
```

**出力:** `~/.openclaw/logs/commands.log`

**ログの表示:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**参照:** [command-logger documentation](/automation/hooks#command-logger)

### soul-evil

パージ ウィンドウ中、またはランダムな確率で、注入された `SOUL.md` コンテンツを `SOUL_EVIL.md` に置き換えます。

**有効化:**

```bash
openclaw hooks enable soul-evil
```

**参照:** [SOUL Evil Hook](/hooks/soul-evil)

### boot-md

ゲートウェイの起動時（チャンネル開始後）に `BOOT.md` を実行します。

**イベント**: `gateway:startup`

**有効化**:

```bash
openclaw hooks enable boot-md
```

**参照:** [boot-md documentation](/automation/hooks#boot-md)
