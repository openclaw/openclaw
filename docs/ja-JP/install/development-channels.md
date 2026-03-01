---
summary: "stable、beta、devチャンネル：セマンティクス、切り替え、タグ付け"
read_when:
  - stable/beta/devを切り替えたい場合
  - プレリリースのタグ付けまたは公開をする場合
title: "開発チャンネル"
---

# 開発チャンネル

最終更新：2026-01-21

OpenClawは3つのアップデートチャンネルを提供しています：

- **stable**：npm dist-tag `latest`。
- **beta**：npm dist-tag `beta`（テスト中のビルド）。
- **dev**：`main`のムービングヘッド（git）。npm dist-tag：`dev`（公開時）。

ビルドを**beta**に配信し、テストした後、バージョン番号を変更せずに**検証済みビルドを`latest`にプロモート**します。npmインストールではdist-tagが正本です。

## チャンネルの切り替え

Gitチェックアウト：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta`は最新の一致するタグをチェックアウトします（同じタグであることが多い）。
- `dev`は`main`に切り替えてアップストリームに対してリベースします。

npm/pnpmグローバルインストール：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

これは対応するnpm dist-tag（`latest`、`beta`、`dev`）を通じてアップデートします。

`--channel`で**明示的に**チャンネルを切り替えると、OpenClawはインストール方法も合わせます：

- `dev`はgitチェックアウトを確保し（デフォルト`~/openclaw`、`OPENCLAW_GIT_DIR`でオーバーライド）、更新して、そのチェックアウトからグローバルCLIをインストールします。
- `stable`/`beta`は一致するdist-tagを使用してnpmからインストールします。

ヒント：stableとdevを並行して使いたい場合は、2つのクローンを保持し、Gatewayをstable側に向けてください。

## プラグインとチャンネル

`openclaw update`でチャンネルを切り替えると、OpenClawはプラグインソースも同期します：

- `dev`はgitチェックアウトからのバンドルプラグインを優先します。
- `stable`と`beta`はnpmインストール済みのプラグインパッケージを復元します。

## タグ付けのベストプラクティス

- gitチェックアウトがランドするリリースにタグを付けてください（stableには`vYYYY.M.D`、betaには`vYYYY.M.D-beta.N`）。
- `vYYYY.M.D.beta.N`も互換性のために認識されますが、`-beta.N`を推奨します。
- レガシーの`vYYYY.M.D-<patch>`タグはstable（非beta）として引き続き認識されます。
- タグはイミュータブルに保ってください：タグを移動したり再利用したりしないでください。
- npm dist-tagはnpmインストールの正本です：
  - `latest` → stable
  - `beta` → 候補ビルド
  - `dev` → mainスナップショット（オプション）

## macOSアプリの提供状況

betaおよびdevビルドにはmacOSアプリリリースが**含まれない**場合があります。問題ありません：

- gitタグとnpm dist-tagは公開可能です。
- リリースノートまたは変更履歴に「このbetaにはmacOSビルドなし」と記載してください。
