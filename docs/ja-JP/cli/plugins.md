---
summary: "`openclaw plugins` の CLI リファレンス（list、install、uninstall、enable/disable、doctor）"
read_when:
  - インプロセス Gateway プラグインのインストールや管理
  - プラグインの読み込み失敗のデバッグ
title: "plugins"
---

# `openclaw plugins`

Gateway プラグイン/エクステンション（インプロセスで読み込まれます）を管理します。

関連:

- プラグインシステム: [プラグイン](/tools/plugin)
- プラグインマニフェスト + スキーマ: [プラグインマニフェスト](/plugins/manifest)
- セキュリティ強化: [セキュリティ](/gateway/security)

## コマンド

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

バンドルされたプラグインは OpenClaw に同梱されていますが、最初は無効状態です。`plugins enable` を使用して
有効化してください。

すべてのプラグインはインライン JSON Schema（`configSchema`、空でも必要）を含む `openclaw.plugin.json` ファイルを同梱する必要があります。マニフェストやスキーマが欠落または無効な場合、プラグインの読み込みが妨げられ、設定の検証に失敗します。

### インストール

```bash
openclaw plugins install <path-or-spec>
openclaw plugins install <npm-spec> --pin
```

セキュリティに関する注意: プラグインのインストールはコードの実行と同等に扱ってください。バージョンを固定することを推奨します。

npm スペックは**レジストリのみ**（パッケージ名 + オプションのバージョン/タグ）です。Git/URL/ファイルスペックは拒否されます。依存関係のインストールは安全のために `--ignore-scripts` で実行されます。

対応アーカイブ形式: `.zip`、`.tgz`、`.tar.gz`、`.tar`。

ローカルディレクトリのコピーを避けるには `--link` を使用します（`plugins.load.paths` に追加されます）:

```bash
openclaw plugins install -l ./my-plugin
```

npm インストール時に `--pin` を使用すると、解決済みの正確なスペック（`name@version`）を
`plugins.installs` に保存します（デフォルトの動作は固定なしです）。

### アンインストール

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` は `plugins.entries`、`plugins.installs`、プラグイン許可リスト、および該当する場合はリンクされた `plugins.load.paths` エントリからプラグインレコードを削除します。
アクティブなメモリプラグインの場合、メモリスロットは `memory-core` にリセットされます。

デフォルトでは、アンインストール時にアクティブなステートディレクトリのエクステンションルート（`$OPENCLAW_STATE_DIR/extensions/<id>`）配下のプラグインインストールディレクトリも削除されます。ファイルをディスクに保持するには `--keep-files` を使用してください。

`--keep-config` は `--keep-files` の非推奨エイリアスとしてサポートされています。

### アップデート

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

アップデートは npm からインストールされたプラグイン（`plugins.installs` で追跡）にのみ適用されます。

保存された整合性ハッシュが存在し、フェッチしたアーティファクトのハッシュが変更された場合、
OpenClaw は警告を表示し、続行前に確認を求めます。CI や非インタラクティブ実行では
グローバルの `--yes` を使用してプロンプトをバイパスできます。
