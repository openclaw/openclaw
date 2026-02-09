---
summary: "OpenClaw macOS アプリで作業する開発者向けのセットアップガイド"
read_when:
  - macOS 開発環境のセットアップ
title: "macOS 開発者セットアップ"
---

# macOS 開発者セットアップ

このガイドでは、OpenClaw macOS アプリケーションをソースからビルドして実行するために必要な手順を説明します。

## 前提条件

アプリをビルドする前に、以下がインストールされていることを確認してください。

1. **Xcode 26.2+**: Swift 開発に必要です。
2. **Node.js 22+ & pnpm**: ゲートウェイ、CLI、パッケージングスクリプトに必要です。

## 1) 依存関係のインストール

プロジェクト全体の依存関係をインストールします。

```bash
pnpm install
```

## 2. アプリのビルドとパッケージ化

macOS アプリをビルドし、`dist/OpenClaw.app` にパッケージ化するには、次を実行します。

```bash
./scripts/package-mac-app.sh
```

Apple Developer ID 証明書をお持ちでない場合、スクリプトは自動的に **アドホック署名**（`-`）を使用します。

開発用の実行モード、署名フラグ、Team ID のトラブルシューティングについては、macOS アプリの README を参照してください。  
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **注記**: アドホック署名されたアプリは、セキュリティの警告を表示する場合があります。アプリが「Abort trap 6」で直ちにクラッシュする場合は、[トラブルシューティング](#troubleshooting) セクションを参照してください。 " [Troubleshooting](#troubleshooting) セクションを参照してください。

## 3. CLI のインストール

macOS アプリは、バックグラウンドタスクを管理するために、グローバルな `openclaw` CLI のインストールを想定しています。

**インストール方法（推奨）:**

1. OpenClaw アプリを開きます。
2. **General** 設定タブに移動します。
3. **「Install CLI」** をクリックします。

または、手動でインストールします。

```bash
npm install -g openclaw@<version>
```

## トラブルシューティング

### ビルド失敗: ツールチェーンまたは SDK の不一致

macOS アプリのビルドでは、最新の macOS SDK と Swift 6.2 ツールチェーンが想定されています。

**システム依存関係（必須）:**

- **ソフトウェアアップデートで提供されている最新の macOS バージョン**（Xcode 26.2 の SDK により必須）
- **Xcode 26.2**（Swift 6.2 ツールチェーン）

**確認方法:**

```bash
xcodebuild -version
xcrun swift --version
```

バージョンが一致しない場合は、macOS／Xcode を更新してからビルドを再実行してください。

### 権限付与時にアプリがクラッシュする

**音声認識** または **マイク** のアクセスを許可しようとした際にアプリがクラッシュする場合、破損した TCC キャッシュや署名の不一致が原因である可能性があります。

**対処方法:**

1. TCC の権限をリセットします。

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. それでも解決しない場合は、[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 内の `BUNDLE_ID` を一時的に変更し、macOS から「クリーンな状態」を強制します。

### ゲートウェイが「Starting...」のまま進まない

ゲートウェイのステータスが「Starting...」のままの場合、ゾンビプロセスがポートを占有していないか確認してください。

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

手動実行がポートを占有している場合は、そのプロセスを停止します（Ctrl+C）。最終手段として、上記で見つかった PID を kill してください。 最後の手段として、上で見つけたPIDを無効にします。
