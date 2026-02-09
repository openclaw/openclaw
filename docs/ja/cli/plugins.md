---
summary: "「openclaw plugins」（一覧、インストール、有効化／無効化、doctor）の CLI リファレンスです"
read_when:
  - インプロセスの Gateway（ゲートウェイ）プラグインをインストールまたは管理したい場合
  - プラグインの読み込み失敗をデバッグしたい場合
title: "プラグイン"
---

# `openclaw plugins`

Gateway（ゲートウェイ）プラグイン／拡張（インプロセスで読み込み）を管理します。

関連項目:

- プラグインシステム: [Plugins](/tools/plugin)
- プラグインマニフェスト + スキーマ: [Plugin manifest](/plugins/manifest)
- セキュリティ強化: [Security](/gateway/security)

## コマンド

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

バンドルされたプラグインは OpenClaw とともに提供されますが、初期状態では無効です。`plugins enable` を使用して有効化します。 9. 有効化するには `plugins enable` を使用してください。

すべてのプラグインは、インラインの JSON Schema（`configSchema`、空であっても）を含む `openclaw.plugin.json` ファイルを同梱する必要があります。マニフェストまたはスキーマが欠落している、または無効な場合、プラグインは読み込まれず、設定の検証に失敗します。 10. マニフェストやスキーマが欠落している、または無効な場合、プラグインは読み込まれず、設定検証は失敗します。

### インストール

```bash
openclaw plugins install <path-or-spec>
```

セキュリティに関する注意: プラグインのインストールはコードの実行と同様に扱ってください。固定（ピン留め）されたバージョンを推奨します。 ピン留めされたバージョンを好みます。

対応アーカイブ: `.zip`、`.tgz`、`.tar.gz`、`.tar`。

ローカルディレクトリのコピーを避けるには `--link` を使用してください（`plugins.load.paths` に追加されます）:

```bash
openclaw plugins install -l ./my-plugin
```

### 更新

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

更新は npm からインストールされたプラグインにのみ適用されます（`plugins.installs` で追跡されます）。
