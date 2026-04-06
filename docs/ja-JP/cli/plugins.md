---
read_when:
    - Gateway ゲートウェイプラグインや互換バンドルをインストール・管理したい場合
    - プラグインの読み込み失敗をデバッグしたい場合
summary: '`openclaw plugins` のCLIリファレンス（list、install、marketplace、uninstall、enable/disable、doctor）'
title: plugins
x-i18n:
    generated_at: "2026-04-02T07:35:21Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 7fe5c49ff31d4ec4b304dab630f4f772132dbbfce95f5a659cc2e0a74d586cb6
    source_path: cli/plugins.md
    workflow: 15
---

# `openclaw plugins`

Gateway ゲートウェイのプラグイン/拡張機能、フックパック、互換バンドルを管理します。

関連：

- プラグインシステム：[プラグイン](/tools/plugin)
- バンドル互換性：[プラグインバンドル](/plugins/bundles)
- プラグインマニフェスト + スキーマ：[プラグインマニフェスト](/plugins/manifest)
- セキュリティ強化：[セキュリティ](/gateway/security)

## コマンド

```bash
openclaw plugins list
openclaw plugins install <path-or-spec>
openclaw plugins inspect <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins uninstall <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins marketplace list <marketplace>
```

バンドルされたプラグインはOpenClawに同梱されていますが、無効状態で起動します。有効にするには `plugins enable` を使用してください。

ネイティブのOpenClawプラグインは、インラインJSONスキーマ（`configSchema`、空でも可）を含む `openclaw.plugin.json` を同梱する必要があります。互換バンドルは代わりに独自のバンドルマニフェストを使用します。

`plugins list` は `Format: openclaw` または `Format: bundle` を表示します。詳細なlist/info出力では、バンドルサブタイプ（`codex`、`claude`、または `cursor`）と検出されたバンドル機能も表示されます。

### インストール

```bash
openclaw plugins install <package>                      # ClawHubを先に確認、次にnpm
openclaw plugins install clawhub:<package>              # ClawHubのみ
openclaw plugins install <package> --pin                # バージョンを固定
openclaw plugins install <package> --dangerously-force-unsafe-install
openclaw plugins install <path>                         # ローカルパス
openclaw plugins install <plugin>@<marketplace>         # マーケットプレイス
openclaw plugins install <plugin> --marketplace <name>  # マーケットプレイス（明示的）
```

パッケージ名のみの場合、まずClawHubを確認し、次にnpmを確認します。セキュリティに関する注意：プラグインのインストールはコードの実行と同等に扱ってください。バージョンを固定することを推奨します。

`--dangerously-force-unsafe-install` は、組み込みの危険コードスキャナーの誤検知に対するブレークグラスオプションです。組み込みスキャナーが `critical` な発見を報告した場合でもインストールを続行できますが、プラグインの `before_install` フックポリシーブロックはバイパス**しません**し、スキャン失敗もバイパス**しません**。

このCLIフラグは `openclaw plugins install` に適用されます。Gateway ゲートウェイベースのSkill依存関係インストールは対応する `dangerouslyForceUnsafeInstall` リクエストオーバーライドを使用し、`openclaw skills install` は別のClawHub Skillダウンロード/インストールフローのままです。

`plugins install` は `package.json` で `openclaw.hooks` を公開するフックパックのインストールサーフェスでもあります。フィルタリングされたフックの表示とフックごとの有効化には、パッケージインストールではなく `openclaw hooks` を使用してください。

npmスペックは**レジストリのみ**（パッケージ名 + オプションの**正確なバージョン**または**dist-tag**）です。Git/URL/ファイルスペックとsemver範囲は拒否されます。依存関係のインストールは安全のため `--ignore-scripts` で実行されます。

スペック指定なしと `@latest` は安定トラックに留まります。npmがこれらのいずれかをプレリリースに解決した場合、OpenClawは停止し、`@beta`/`@rc` などのプレリリースタグ、または `@1.2.3-beta.4` のような正確なプレリリースバージョンで明示的にオプトインするよう求めます。

インストールスペックがバンドルされたプラグインID（例：`diffs`）と一致する場合、OpenClawはバンドルされたプラグインを直接インストールします。同じ名前のnpmパッケージをインストールするには、明示的なスコープ付きスペック（例：`@scope/diffs`）を使用してください。

サポートされるアーカイブ：`.zip`、`.tgz`、`.tar.gz`、`.tar`。

Claudeマーケットプレイスからのインストールもサポートされています。

ClawHubインストールは明示的な `clawhub:<package>` ロケーターを使用します：

```bash
openclaw plugins install clawhub:openclaw-codex-app-server
openclaw plugins install clawhub:openclaw-codex-app-server@1.2.3
```

OpenClawは、npm互換のプラグインスペックについてもClawHubを優先するようになりました。ClawHubに該当パッケージまたはバージョンがない場合のみnpmにフォールバックします：

```bash
openclaw plugins install openclaw-codex-app-server
```

OpenClawはClawHubからパッケージアーカイブをダウンロードし、アドバタイズされたプラグインAPI / 最小Gateway ゲートウェイ互換性を確認してから、通常のアーカイブパスでインストールします。記録されたインストールは後の更新のためにClawHubソースメタデータを保持します。

Claudeのローカルレジストリキャッシュ `~/.claude/plugins/known_marketplaces.json` にマーケットプレイス名が存在する場合、`plugin@marketplace` の省略記法を使用できます：

```bash
openclaw plugins marketplace list <marketplace-name>
openclaw plugins install <plugin-name>@<marketplace-name>
```

マーケットプレイスソースを明示的に渡したい場合は `--marketplace` を使用します：

```bash
openclaw plugins install <plugin-name> --marketplace <marketplace-name>
openclaw plugins install <plugin-name> --marketplace <owner/repo>
openclaw plugins install <plugin-name> --marketplace ./my-marketplace
```

マーケットプレイスソースは以下のいずれかです：

- `~/.claude/plugins/known_marketplaces.json` のClaude既知マーケットプレイス名
- ローカルのマーケットプレイスルートまたは `marketplace.json` パス
- `owner/repo` のようなGitHubリポジトリ省略記法
- git URL

GitHubまたはgitから読み込まれたリモートマーケットプレイスの場合、プラグインエントリはクローンされたマーケットプレイスリポジトリ内に留まる必要があります。OpenClawはそのリポジトリからの相対パスソースを受け入れ、リモートマニフェストからの外部git、GitHub、URL/アーカイブ、絶対パスのプラグインソースは拒否します。

ローカルパスとアーカイブの場合、OpenClawは以下を自動検出します：

- ネイティブOpenClawプラグイン（`openclaw.plugin.json`）
- Codex互換バンドル（`.codex-plugin/plugin.json`）
- Claude互換バンドル（`.claude-plugin/plugin.json` またはデフォルトのClaudeコンポーネントレイアウト）
- Cursor互換バンドル（`.cursor-plugin/plugin.json`）

互換バンドルは通常の拡張機能ルートにインストールされ、同じlist/info/enable/disableフローに参加します。現在、バンドルSkills、Claudeコマンドスキル、Claude `settings.json` デフォルト、Cursorコマンドスキル、および互換Codexフックディレクトリがサポートされています。その他の検出されたバンドル機能は診断/情報に表示されますが、ランタイム実行にはまだ接続されていません。

ローカルディレクトリのコピーを避けるには `--link` を使用します（`plugins.load.paths` に追加されます）：

```bash
openclaw plugins install -l ./my-plugin
```

npmインストールで `--pin` を使用すると、解決された正確なスペック（`name@version`）を `plugins.installs` に保存しつつ、デフォルトの動作は固定なしのままにします。

### アンインストール

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` は `plugins.entries`、`plugins.installs`、プラグイン許可リスト、および該当する場合はリンクされた `plugins.load.paths` エントリからプラグインレコードを削除します。アクティブなメモリプラグインの場合、メモリスロットは `memory-core` にリセットされます。

デフォルトでは、アンインストールはアクティブなstate-dirプラグインルート配下のプラグインインストールディレクトリも削除します。ファイルをディスクに残すには `--keep-files` を使用してください。

`--keep-config` は `--keep-files` の非推奨エイリアスとしてサポートされています。

### 更新

```bash
openclaw plugins update <id-or-npm-spec>
openclaw plugins update --all
openclaw plugins update <id-or-npm-spec> --dry-run
openclaw plugins update @openclaw/voice-call@beta
```

更新は `plugins.installs` の追跡されたインストールと `hooks.internal.installs` の追跡されたフックパックインストールに適用されます。

プラグインIDを渡すと、OpenClawはそのプラグインの記録されたインストールスペックを再利用します。つまり、`@beta` などの以前保存されたdist-tagや固定された正確なバージョンは、その後の `update <id>` 実行でも引き続き使用されます。

npmインストールの場合、dist-tagまたは正確なバージョンを含む明示的なnpmパッケージスペックを渡すこともできます。OpenClawはそのパッケージ名を追跡されたプラグインレコードに解決し、インストール済みプラグインを更新し、将来のIDベースの更新のために新しいnpmスペックを記録します。

保存された整合性ハッシュが存在し、取得したアーティファクトのハッシュが変更された場合、OpenClawは警告を出力し、続行前に確認を求めます。CI/非対話的実行でプロンプトをバイパスするにはグローバル `--yes` を使用してください。

### 検査

```bash
openclaw plugins inspect <id>
openclaw plugins inspect <id> --json
```

単一プラグインの詳細な内部検査です。アイデンティティ、読み込み状態、ソース、登録された機能、フック、ツール、コマンド、サービス、Gateway ゲートウェイメソッド、HTTPルート、ポリシーフラグ、診断情報、インストールメタデータを表示します。

各プラグインは、ランタイムで実際に登録する内容に基づいて分類されます：

- **plain-capability** — 1つの機能タイプ（例：プロバイダーのみのプラグイン）
- **hybrid-capability** — 複数の機能タイプ（例：テキスト + 音声 + 画像）
- **hook-only** — フックのみ、機能やサーフェスなし
- **non-capability** — ツール/コマンド/サービスはあるが機能なし

機能モデルの詳細は[プラグインの形態](/plugins/architecture#plugin-shapes)を参照してください。

`--json` フラグはスクリプティングや監査に適した機械可読なレポートを出力します。

`info` は `inspect` のエイリアスです。
