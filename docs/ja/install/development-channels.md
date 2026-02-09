---
summary: "stable、beta、dev チャンネル：意味、切り替え、タグ付け"
read_when:
  - stable / beta / dev を切り替えたい場合
  - プレリリースをタグ付けまたは公開する場合
title: "開発チャンネル"
---

# 開発チャンネル

最終更新日: 2026-01-21

OpenClaw には 3 つのアップデートチャンネルがあります。

- **stable**: npm dist-tag `latest`。
- **beta**: npm dist-tag `beta`（テスト中のビルド）。
- **dev**: `main`（git）の移動する最新ヘッド。npm dist-tag: `dev`（公開時）。 npm dist-tag: `dev` (公開時)

ビルドはまず **beta** に配布してテストし、その後 **検証済みのビルドを `latest` に昇格** します。
この際、バージョン番号は変更しません。npm インストールにおける信頼できる情報源は dist-tag です。

## チャンネルの切り替え

Git のチェックアウト:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` は、最新の一致するタグをチェックアウトします（多くの場合、同じタグです）。
- `dev` は `main` に切り替え、upstream 上でリベースします。

npm / pnpm のグローバルインストール:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

これは対応する npm dist-tag（`latest`、`beta`、`dev`）経由で更新されます。

`--channel` を使って **明示的に** チャンネルを切り替えると、OpenClaw は
インストール方法も揃えます。

- `dev` は git チェックアウトを保証し（デフォルトは `~/openclaw`、`OPENCLAW_GIT_DIR` で上書き可能）、
  それを更新し、そのチェックアウトからグローバル CLI をインストールします。
- `stable`/`beta` は、対応する dist-tag を使って npm からインストールします。

ヒント: stable と dev を並行して使いたい場合は、2 つのクローンを保持し、Gateway（ゲートウェイ）を stable 側に向けてください。

## プラグインとチャンネル

`openclaw update` でチャンネルを切り替えると、OpenClaw はプラグインのソースも同期します。

- `dev` は、git チェックアウトに含まれるバンドル済みプラグインを優先します。
- `stable` と `beta` は、npm でインストールされたプラグインパッケージを復元します。

## タグ付けのベストプラクティス

- git チェックアウトが到達してほしいリリースにはタグを付けてください（`vYYYY.M.D` または `vYYYY.M.D-<patch>`）。
- タグは不変に保ちます。タグを移動したり再利用したりしないでください。
- npm インストールにおいては、npm dist-tag が引き続き信頼できる情報源です。
  - `latest` → stable
  - `beta` → 候補ビルド
  - `dev` → main のスナップショット（任意）

## macOS アプリの提供状況

beta および dev ビルドには、macOS アプリのリリースが **含まれない** 場合があります。問題ありません。 問題ありません:

- git タグおよび npm dist-tag は引き続き公開できます。
- リリースノートや変更履歴で「この beta には macOS ビルドなし」と明記してください。
