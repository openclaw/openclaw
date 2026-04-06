---
read_when:
    - ソースチェックアウトを安全に更新したいとき
    - '`--update` ショートハンドの動作を理解したいとき'
summary: '`openclaw update` の CLI リファレンス（安全なソース更新と Gateway ゲートウェイの自動再起動）'
title: update
x-i18n:
    generated_at: "2026-04-02T07:36:22Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6097aa26402906f344d83f9bd21bc6db532b8893a36d187babd40072a4a33e7f
    source_path: cli/update.md
    workflow: 15
---

# `openclaw update`

OpenClaw を安全に更新し、stable/beta/dev チャネルを切り替えます。

**npm/pnpm**（グローバルインストール、git メタデータなし）でインストールした場合、更新は[更新](/install/updating)のパッケージマネージャーフローで行います。

## 使い方

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --tag main
openclaw update --dry-run
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## オプション

- `--no-restart`: 更新成功後の Gateway ゲートウェイサービスの再起動をスキップします。
- `--channel <stable|beta|dev>`: 更新チャネルを設定します（git + npm、設定に永続化されます）。
- `--tag <dist-tag|version|spec>`: この更新のみパッケージターゲットを上書きします。パッケージインストールの場合、`main` は `github:openclaw/openclaw#main` にマッピングされます。
- `--dry-run`: 設定の書き込み、インストール、プラグイン同期、再起動を行わず、予定される更新アクション（チャネル/タグ/ターゲット/再起動フロー）をプレビューします。
- `--json`: 機械可読な `UpdateRunResult` JSON を出力します。
- `--timeout <seconds>`: ステップごとのタイムアウト（デフォルトは1200秒）。

注意: ダウングレードは設定を破損する可能性があるため、確認が必要です。

## `update status`

アクティブな更新チャネルと git タグ/ブランチ/SHA（ソースチェックアウトの場合）、および更新の利用可能状況を表示します。

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

オプション:

- `--json`: 機械可読なステータス JSON を出力します。
- `--timeout <seconds>`: チェックのタイムアウト（デフォルトは3秒）。

## `update wizard`

更新チャネルを選択し、更新後に Gateway ゲートウェイを再起動するかどうかを確認する対話型フローです（デフォルトでは再起動します）。git チェックアウトなしで `dev` を選択した場合、チェックアウトの作成を提案します。

## 動作内容

チャネルを明示的に切り替えた場合（`--channel ...`）、OpenClaw はインストール方法も揃えます:

- `dev` → git チェックアウトを確保し（デフォルト: `~/openclaw`、`OPENCLAW_GIT_DIR` で上書き可能）、更新してからそのチェックアウトからグローバル CLI をインストールします。
- `stable`/`beta` → 対応する dist-tag を使用して npm からインストールします。

Gateway ゲートウェイコアの自動アップデーター（設定で有効化した場合）は、同じ更新パスを再利用します。

## Git チェックアウトフロー

チャネル:

- `stable`: 最新の非ベータタグをチェックアウトし、ビルド + doctor を実行します。
- `beta`: 最新の `-beta` タグをチェックアウトし、ビルド + doctor を実行します。
- `dev`: `main` をチェックアウトし、fetch + rebase を実行します。

概要:

1. クリーンなワークツリーが必要です（コミットされていない変更がないこと）。
2. 選択したチャネル（タグまたはブランチ）に切り替えます。
3. upstream を fetch します（dev のみ）。
4. dev のみ: 一時ワークツリーで事前にリント + TypeScript ビルドを実行します。先端のコミットが失敗した場合、最新のクリーンビルドを見つけるために最大10コミット遡ります。
5. 選択したコミットにリベースします（dev のみ）。
6. 依存関係をインストールします（pnpm 優先、npm フォールバック）。
7. ビルドとコントロール UI のビルドを行います。
8. 最終的な「安全な更新」チェックとして `openclaw doctor` を実行します。
9. プラグインをアクティブなチャネルに同期し（dev はバンドルされた拡張機能を使用、stable/beta は npm を使用）、npm でインストールされたプラグインを更新します。

## `--update` ショートハンド

`openclaw --update` は `openclaw update` に書き換えられます（シェルやランチャースクリプトで便利です）。

## 関連項目

- `openclaw doctor`（git チェックアウトの場合、先に更新の実行を提案します）
- [開発チャネル](/install/development-channels)
- [更新](/install/updating)
- [CLI リファレンス](/cli)
