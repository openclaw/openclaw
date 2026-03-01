---
summary: "`openclaw update` の CLI リファレンス（安全なソースアップデート + Gateway 自動再起動）"
read_when:
  - ソースチェックアウトを安全にアップデートしたい場合
  - `--update` ショートハンドの動作を理解したい場合
title: "update"
---

# `openclaw update`

OpenClaw を安全にアップデートし、stable/beta/dev チャンネルを切り替えます。

**npm/pnpm**（グローバルインストール、git メタデータなし）でインストールした場合、アップデートは [アップデート](/install/updating) のパッケージマネージャーフローで行います。

## 使い方

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --dry-run
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## オプション

- `--no-restart`: アップデート成功後の Gateway サービスの再起動をスキップします。
- `--channel <stable|beta|dev>`: アップデートチャンネルを設定します（git + npm。設定に永続化されます）。
- `--tag <dist-tag|version>`: この回のアップデートのみ npm dist-tag またはバージョンをオーバーライドします。
- `--dry-run`: 設定の書き込み、インストール、プラグインの同期、再起動を行わずに、計画されたアップデートアクション（チャンネル/タグ/ターゲット/再起動フロー）をプレビューします。
- `--json`: 機械可読な `UpdateRunResult` JSON を出力します。
- `--timeout <seconds>`: ステップごとのタイムアウト（デフォルトは 1200 秒）。

注意: ダウングレードは古いバージョンが設定を壊す可能性があるため、確認が必要です。

## `update status`

アクティブなアップデートチャンネル + git タグ/ブランチ/SHA（ソースチェックアウトの場合）、およびアップデートの可用性を表示します。

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

オプション:

- `--json`: 機械可読なステータス JSON を出力します。
- `--timeout <seconds>`: チェックのタイムアウト（デフォルトは 3 秒）。

## `update wizard`

アップデートチャンネルを選択し、アップデート後に Gateway を再起動するかどうかを確認する
インタラクティブフローです（デフォルトは再起動します）。git チェックアウトなしで `dev` を選択した場合、
チェックアウトの作成を提案します。

## 動作内容

チャンネルを明示的に切り替えた場合（`--channel ...`）、OpenClaw はインストール方法も
一致させます:

- `dev` → git チェックアウトを確保し（デフォルト: `~/openclaw`、`OPENCLAW_GIT_DIR` でオーバーライド可能）、
  アップデートして、そのチェックアウトからグローバル CLI をインストールします。
- `stable`/`beta` → 対応する dist-tag を使用して npm からインストールします。

Gateway コアの自動アップデーター（設定で有効化した場合）も同じアップデートパスを再利用します。

## Git チェックアウトフロー

チャンネル:

- `stable`: 最新の非ベータタグをチェックアウトし、ビルド + doctor を実行します。
- `beta`: 最新の `-beta` タグをチェックアウトし、ビルド + doctor を実行します。
- `dev`: `main` をチェックアウトし、フェッチ + リベースします。

概要:

1. クリーンなワークツリーが必要です（未コミットの変更がないこと）。
2. 選択したチャンネル（タグまたはブランチ）に切り替えます。
3. upstream からフェッチします（dev のみ）。
4. dev のみ: 一時ワークツリーでプリフライトの lint + TypeScript ビルドを実行します。先端が失敗した場合、最新のクリーンビルドを見つけるために最大10コミット遡ります。
5. 選択したコミットにリベースします（dev のみ）。
6. 依存関係をインストールします（pnpm 優先、npm フォールバック）。
7. ビルド + Control UI のビルドを行います。
8. 最終的な「安全なアップデート」チェックとして `openclaw doctor` を実行します。
9. プラグインをアクティブチャンネルに同期します（dev はバンドルエクステンションを使用、stable/beta は npm を使用）。npm インストール済みプラグインをアップデートします。

## `--update` ショートハンド

`openclaw --update` は `openclaw update` に書き換えられます（シェルやランチャースクリプトで便利です）。

## 関連項目

- `openclaw doctor`（git チェックアウトで最初にアップデートの実行を提案します）
- [開発チャンネル](/install/development-channels)
- [アップデート](/install/updating)
- [CLI リファレンス](/cli)
