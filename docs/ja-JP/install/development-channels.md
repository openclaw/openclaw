---
read_when:
    - 安定版/ベータ版/開発版を切り替えたい場合
    - 特定のバージョン、タグ、またはSHAにピン留めしたい場合
    - プレリリースのタグ付けまたは公開を行う場合
sidebarTitle: Release Channels
summary: 安定版、ベータ版、開発版チャネル：セマンティクス、切り替え、ピン留め、タグ付け
title: リリースチャネル
x-i18n:
    generated_at: "2026-04-02T07:45:04Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 5ceeff243e8188c5eb15ff9c423ac564d7c46aec7b88a93524667fa94638b99c
    source_path: install/development-channels.md
    workflow: 15
---

# 開発チャネル

OpenClawには3つのアップデートチャネルがあります：

- **stable**: npm dist-tag `latest`。ほとんどのユーザーに推奨。
- **beta**: npm dist-tag `beta`（テスト中のビルド）。
- **dev**: `main` の最新HEAD（git）。npm dist-tag: `dev`（公開時）。
  `main` ブランチは実験と活発な開発のためのものです。不完全な機能や破壊的変更が含まれる場合があります。本番の Gateway ゲートウェイには使用しないでください。

ビルドを **beta** に公開し、テストを行った後、バージョン番号を変更せずに **検証済みのビルドを `latest` に昇格** します。npmインストールにおいてはdist-tagが信頼できる情報源です。

## チャネルの切り替え

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

`--channel` は設定（`update.channel`）に選択を永続化し、インストール方法を合わせます：

- **`stable`/`beta`**（パッケージインストール）：対応するnpm dist-tagで更新します。
- **`stable`/`beta`**（gitインストール）：対応する最新のgitタグをチェックアウトします。
- **`dev`**：gitチェックアウト（デフォルト `~/openclaw`、`OPENCLAW_GIT_DIR` で上書き可能）を確保し、`main` に切り替え、upstreamにリベースし、ビルドして、そのチェックアウトからグローバルCLIをインストールします。

ヒント：stableとdevを並行して使いたい場合は、クローンを2つ用意し、Gateway ゲートウェイをstable側に向けてください。

## 一回限りのバージョンまたはタグ指定

`--tag` を使用すると、永続化されたチャネルを**変更せずに**、単一の更新で特定のdist-tag、バージョン、またはパッケージ指定を対象にできます：

```bash
# 特定のバージョンをインストール
openclaw update --tag 2026.4.1-beta.1

# beta dist-tagからインストール（一回限り、永続化されない）
openclaw update --tag beta

# GitHubのmainブランチからインストール（npm tarball）
openclaw update --tag main

# 特定のnpmパッケージ指定をインストール
openclaw update --tag openclaw@2026.4.1-beta.1
```

注意事項：

- `--tag` は**パッケージ（npm）インストールのみ**に適用されます。gitインストールでは無視されます。
- タグは永続化されません。次回の `openclaw update` は通常どおり設定済みのチャネルを使用します。
- ダウングレード保護：対象バージョンが現在のバージョンより古い場合、OpenClawは確認を求めます（`--yes` でスキップ可能）。

## ドライラン

変更を加えずに `openclaw update` が何を行うかをプレビューします：

```bash
openclaw update --dry-run
openclaw update --channel beta --dry-run
openclaw update --tag 2026.4.1-beta.1 --dry-run
openclaw update --dry-run --json
```

ドライランでは、有効なチャネル、対象バージョン、計画されたアクション、およびダウングレード確認が必要かどうかが表示されます。

## プラグインとチャネル

`openclaw update` でチャネルを切り替えると、OpenClawはプラグインのソースも同期します：

- `dev` はgitチェックアウトのバンドルされたプラグインを優先します。
- `stable` と `beta` はnpmでインストールされたプラグインパッケージを復元します。
- npmでインストールされたプラグインは、コアの更新が完了した後に更新されます。

## 現在のステータスの確認

```bash
openclaw update status
```

アクティブなチャネル、インストール種別（gitまたはパッケージ）、現在のバージョン、およびソース（設定、gitタグ、gitブランチ、またはデフォルト）が表示されます。

## タグ付けのベストプラクティス

- gitチェックアウトが到達すべきリリースにタグを付けてください（stableには `vYYYY.M.D`、betaには `vYYYY.M.D-beta.N`）。
- `vYYYY.M.D.beta.N` も互換性のために認識されますが、`-beta.N` を推奨します。
- レガシーの `vYYYY.M.D-<patch>` タグもstable（非beta）として認識されます。
- タグは不変に保ってください：タグの移動や再利用は行わないでください。
- npm dist-tagがnpmインストールの信頼できる情報源です：
  - `latest` -> stable
  - `beta` -> 候補ビルド
  - `dev` -> mainスナップショット（任意）

## macOSアプリの提供状況

ベータ版および開発版ビルドでは、macOSアプリのリリースが**含まれない場合があります**。これは問題ありません：

- gitタグとnpm dist-tagは引き続き公開できます。
- リリースノートまたはchangelogに「このベータにはmacOSビルドはありません」と記載してください。
