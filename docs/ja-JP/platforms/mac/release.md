---
summary: "OpenClaw macOSリリースチェックリスト（Sparkleフィード、パッケージング、署名）"
read_when:
  - OpenClaw macOSリリースの作成または検証
  - Sparkle appcastまたはフィードアセットの更新
title: "macOSリリース"
---

# OpenClaw macOSリリース（Sparkle）

このアプリはSparkle自動更新を提供するようになりました。リリースビルドはDeveloper IDで署名し、zip化し、署名済みのappcastエントリとともに公開する必要があります。

## 前提条件

- Developer ID Application証明書がインストール済み（例：`Developer ID Application: <Developer Name> (<TEAMID>)`）。
- Sparkle秘密鍵のパスが環境変数`SPARKLE_PRIVATE_KEY_FILE`に設定済み（Sparkle ed25519秘密鍵へのパス。公開鍵はInfo.plistに組み込み済み）。見つからない場合は`~/.profile`を確認してください。
- `xcrun notarytool`用のNotary認証情報（キーチェーンプロファイルまたはAPIキー）。Gatekeeper対応のDMG/zip配布に必要です。
  - `openclaw-notary`という名前のキーチェーンプロファイルを使用します。シェルプロファイルのApp Store Connect APIキー環境変数から作成します：
    - `APP_STORE_CONNECT_API_KEY_P8`、`APP_STORE_CONNECT_KEY_ID`、`APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm`の依存関係がインストール済み（`pnpm install --config.node-linker=hoisted`）。
- Sparkleツールは`apps/macos/.build/artifacts/sparkle/Sparkle/bin/`（`sign_update`、`generate_appcast`など）でSwiftPM経由で自動取得されます。

## ビルドとパッケージング

注意事項：

- `APP_BUILD`は`CFBundleVersion`/`sparkle:version`にマッピングされます。数値で単調増加にしてください（`-beta`は不可）。そうしないとSparkleが同一として比較します。
- `APP_BUILD`を省略すると、`scripts/package-mac-app.sh`は`APP_VERSION`からSparkle安全なデフォルトを導出します（`YYYYMMDDNN`：安定版はデフォルト`90`、プレリリースはサフィックス派生のレーン）。gitコミット数との大きい方を使用します。
- リリースエンジニアリングで特定の単調増加値が必要な場合は、`APP_BUILD`を明示的にオーバーライドできます。
- デフォルトは現在のアーキテクチャ（`$(uname -m)`）です。リリース/ユニバーサルビルドの場合は`BUILD_ARCHS="arm64 x86_64"`（または`BUILD_ARCHS=all`）を設定してください。
- リリースアーティファクト（zip + DMG + 公証）には`scripts/package-mac-dist.sh`を使用します。ローカル/開発パッケージングには`scripts/package-mac-app.sh`を使用します。

```bash
# リポジトリルートから実行。SparkleフィードにリリースIDを設定します。
# APP_BUILDはSparkle比較のために数値+単調増加である必要があります。
# 省略時はAPP_VERSIONから自動導出されます。
BUNDLE_ID=ai.openclaw.mac \
APP_VERSION=2026.2.27 \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# 配布用zip（Sparkleデルタサポート用のリソースフォークを含む）
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.27.zip

# オプション：人間向けのスタイル付きDMGもビルド（/Applicationsにドラッグ）
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.27.dmg

# 推奨：ビルド + 公証/ステープル zip + DMG
# まず、キーチェーンプロファイルを一度作成します：
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=ai.openclaw.mac \
APP_VERSION=2026.2.27 \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# オプション：リリースと一緒にdSYMも配布
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.27.dSYM.zip
```

## Appcastエントリ

SparkleがフォーマットされたHTMLノートをレンダリングするように、リリースノートジェネレーターを使用します：

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.27.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

`CHANGELOG.md`からHTMLリリースノートを生成し（[`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)経由）、appcastエントリに埋め込みます。
公開時には、更新された`appcast.xml`をリリースアセット（zip + dSYM）と一緒にコミットしてください。

## 公開と検証

- `OpenClaw-2026.2.27.zip`（および`OpenClaw-2026.2.27.dSYM.zip`）をタグ`v2026.2.27`のGitHubリリースにアップロードします。
- RAW appcast URLが組み込みフィードと一致することを確認します：`https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`。
- 正常性チェック：
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`が200を返す。
  - アセットアップロード後に`curl -I <enclosure url>`が200を返す。
  - 以前のパブリックビルドで、Aboutタブから「Check for Updates...」を実行し、Sparkleが新しいビルドを正常にインストールすることを確認する。

完了の定義：署名済みアプリ + appcastが公開され、古いインストール済みバージョンから更新フローが動作し、リリースアセットがGitHubリリースに添付されていること。
