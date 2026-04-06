---
read_when:
    - ローカルのOpenClaw状態のファーストクラスなバックアップアーカイブが必要な場合
    - リセットやアンインストール前にどのパスが含まれるかプレビューしたい場合
summary: '`openclaw backup`のCLIリファレンス（ローカルバックアップアーカイブの作成）'
title: backup
x-i18n:
    generated_at: "2026-04-02T07:32:46Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4ee33408825acdb3983ed5ddf57610062730fa18d079bbad902c272938393c54
    source_path: cli/backup.md
    workflow: 15
---

# `openclaw backup`

OpenClawの状態、設定、認証情報、セッション、およびオプションでワークスペースのローカルバックアップアーカイブを作成します。

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
```

## 注意事項

- アーカイブには、解決済みのソースパスとアーカイブレイアウトを含む`manifest.json`ファイルが含まれます。
- デフォルトの出力先は、現在の作業ディレクトリにタイムスタンプ付きの`.tar.gz`アーカイブです。
- 現在の作業ディレクトリがバックアップ対象のソースツリー内にある場合、OpenClawはデフォルトのアーカイブ保存先としてホームディレクトリにフォールバックします。
- 既存のアーカイブファイルは上書きされません。
- ソースの状態/ワークスペースツリー内の出力パスは、自己包含を避けるために拒否されます。
- `openclaw backup verify <archive>`は、アーカイブにルートマニフェストが1つだけ含まれていることを検証し、トラバーサルスタイルのアーカイブパスを拒否し、マニフェストで宣言されたすべてのペイロードがtarball内に存在することを確認します。
- `openclaw backup create --verify`は、アーカイブの書き込み直後にその検証を実行します。
- `openclaw backup create --only-config`は、アクティブなJSON設定ファイルのみをバックアップします。

## バックアップ対象

`openclaw backup create`は、ローカルのOpenClawインストールからバックアップソースを計画します：

- OpenClawのローカル状態リゾルバーが返す状態ディレクトリ（通常は`~/.openclaw`）
- アクティブな設定ファイルのパス
- OAuth/認証情報ディレクトリ
- 現在の設定から検出されたワークスペースディレクトリ（`--no-include-workspace`を指定しない場合）

`--only-config`を使用する場合、OpenClawは状態、認証情報、ワークスペースの検出をスキップし、アクティブな設定ファイルのパスのみをアーカイブします。

OpenClawはアーカイブを構築する前にパスを正規化します。設定、認証情報、またはワークスペースが既に状態ディレクトリ内にある場合、個別のトップレベルバックアップソースとして重複しません。存在しないパスはスキップされます。

アーカイブのペイロードはそれらのソースツリーからのファイル内容を格納し、埋め込みの`manifest.json`は解決済みの絶対ソースパスと各アセットに使用されたアーカイブレイアウトを記録します。

## 無効な設定時の動作

`openclaw backup`はリカバリー時にも機能できるよう、通常の設定プリフライトを意図的にバイパスします。ワークスペースの検出は有効な設定に依存するため、設定ファイルが存在するが無効で、ワークスペースバックアップが有効な場合、`openclaw backup create`は即座に失敗します。

その状況でも部分的なバックアップが必要な場合は、以下を再実行してください：

```bash
openclaw backup create --no-include-workspace
```

これにより、ワークスペースの検出を完全にスキップしつつ、状態、設定、認証情報をスコープ内に保持します。

設定ファイル自体のコピーのみが必要な場合、`--only-config`もワークスペース検出のための設定解析に依存しないため、設定が不正な形式でも機能します。

## サイズとパフォーマンス

OpenClawは組み込みの最大バックアップサイズやファイルごとのサイズ制限を強制しません。

実際の制限はローカルマシンと出力先のファイルシステムに依存します：

- 一時アーカイブの書き込みと最終アーカイブに必要な空き容量
- 大きなワークスペースツリーの走査と`.tar.gz`への圧縮にかかる時間
- `openclaw backup create --verify`を使用するか`openclaw backup verify`を実行する場合のアーカイブ再スキャンにかかる時間
- 出力先パスでのファイルシステムの動作。OpenClawは上書きなしのハードリンクによる公開ステップを優先し、ハードリンクがサポートされていない場合は排他的コピーにフォールバックします

大きなワークスペースが通常、アーカイブサイズの主な要因です。より小さなまたは高速なバックアップが必要な場合は、`--no-include-workspace`を使用してください。

最小のアーカイブにするには、`--only-config`を使用してください。
