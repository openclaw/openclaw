---
summary: "「openclaw update」の CLI リファレンス（安全性を重視したソース更新 + ゲートウェイの自動再起動）"
read_when:
  - ソースのチェックアウトを安全に更新したい場合
  - 「--update」の省略指定の挙動を理解する必要がある場合
title: "update"
---

# `openclaw update`

OpenClaw を安全に更新し、stable/beta/dev チャンネルを切り替えます。

**npm/pnpm** 経由でインストールした場合（グローバルインストール、git メタデータなし）、更新は [Updating](/install/updating) に記載のパッケージマネージャーのフローで行われます。

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: 更新成功後に Gateway サービスを再起動しないようにします。
- `--channel <stable|beta|dev>`: 更新チャンネルを設定します（git + npm；設定に永続化されます）。
- `--tag <dist-tag|version>`: この更新に限り npm の dist-tag またはバージョンを上書きします。
- `--json`: 機械可読な `UpdateRunResult` JSON を出力します。
- `--timeout <seconds>`: 手順ごとのタイムアウト（デフォルトは 1200s）。

注記: ダウングレードは、古いバージョンが設定を破壊する可能性があるため、確認が必要です。

## `update status`

アクティブな更新チャンネルと、git タグ/ブランチ/SHA（ソースのチェックアウトの場合）、および更新の可用性を表示します。

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: 機械可読なステータス JSON を出力します。
- `--timeout <seconds>`: チェックのタイムアウト（デフォルトは 3s）。

## `update wizard`

更新チャンネルを選択し、アップデート後にゲートウェイ
を再起動するかどうかを確認するための対話フローです(デフォルトは再起動します)。 git checkout なしで `dev` を選択した場合、
で作成することができます。

## What it does

チャンネルを明示的に切り替える場合（`--channel ...`）、OpenClaw は
インストール方法も整合させます。

- `dev` → git のチェックアウトを確保します（デフォルト: `~/openclaw`、`OPENCLAW_GIT_DIR` で上書き可能）。
  その後更新し、そのチェックアウトからグローバル CLI をインストールします。
- `stable`/`beta` → 対応する dist-tag を使用して npm からインストールします。

## Git checkout flow

Channels:

- `stable`: 最新の非ベータタグをチェックアウトし、build + doctor を実行します。
- `beta`: 最新の `-beta` タグをチェックアウトし、build + doctor を実行します。
- `dev`: `main` をチェックアウトし、fetch + rebase を実行します。

High-level:

1. クリーンな worktree（未コミットの変更がないこと）が必要です。
2. 選択したチャンネル（タグまたはブランチ）に切り替えます。
3. upstream を fetch します（dev のみ）。
4. dev のみ: 一時 worktree で事前検証の lint + TypeScript ビルドを実行します。先端が失敗した場合、最大 10 コミットまで遡って最新のクリーンなビルドを探します。
5. 選択したコミットに rebase します（dev のみ）。
6. 依存関係をインストールします（pnpm を優先；npm はフォールバック）。
7. ビルドを実行し、Control UI をビルドします。
8. 最終の「安全な更新」チェックとして `openclaw doctor` を実行します。
9. プラグインをアクティブなチャンネルに同期します（dev は同梱拡張を使用；stable/beta は npm を使用）し、npm インストールのプラグインを更新します。

## `--update` shorthand

`openclaw --update` は `openclaw update` に書き換えられます（シェルやランチャースクリプトに便利です）。

## See also

- `openclaw doctor`（git のチェックアウトでは、まず update を実行することを提案します）
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
