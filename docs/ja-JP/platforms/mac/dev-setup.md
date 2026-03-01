---
summary: "OpenClaw macOSアプリの開発者向けセットアップガイド"
read_when:
  - macOS開発環境のセットアップ
title: "macOS開発セットアップ"
---

# macOS開発者セットアップ

このガイドでは、OpenClaw macOSアプリケーションをソースからビルドして実行するために必要な手順を説明します。

## 前提条件

アプリをビルドする前に、以下がインストールされていることを確認してください：

1. **Xcode 26.2+**：Swift開発に必要です。
2. **Node.js 22+ & pnpm**：Gateway、CLI、パッケージングスクリプトに必要です。

## 1. 依存関係のインストール

プロジェクト全体の依存関係をインストールします：

```bash
pnpm install
```

## 2. アプリのビルドとパッケージング

macOSアプリをビルドして`dist/OpenClaw.app`にパッケージングするには、以下を実行します：

```bash
./scripts/package-mac-app.sh
```

Apple Developer ID証明書がない場合、スクリプトは自動的に**アドホック署名**（`-`）を使用します。

開発実行モード、署名フラグ、Team IDのトラブルシューティングについては、macOSアプリのREADMEを参照してください：
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **注意**：アドホック署名されたアプリはセキュリティプロンプトが表示される場合があります。「Abort trap 6」ですぐにクラッシュする場合は、[トラブルシューティング](#トラブルシューティング)セクションを参照してください。

## 3. CLIのインストール

macOSアプリはバックグラウンドタスクを管理するためにグローバルな`openclaw` CLIインストールを必要とします。

**インストール方法（推奨）：**

1. OpenClawアプリを開きます。
2. **General**設定タブに移動します。
3. **「Install CLI」** をクリックします。

または、手動でインストールすることもできます：

```bash
npm install -g openclaw@<version>
```

## トラブルシューティング

### ビルド失敗：ツールチェーンまたはSDKの不一致

macOSアプリのビルドには最新のmacOS SDKとSwift 6.2ツールチェーンが必要です。

**システム依存関係（必須）：**

- **ソフトウェアアップデートで利用可能な最新のmacOSバージョン**（Xcode 26.2 SDKに必要）
- **Xcode 26.2**（Swift 6.2ツールチェーン）

**確認方法：**

```bash
xcodebuild -version
xcrun swift --version
```

バージョンが一致しない場合は、macOS/Xcodeを更新してビルドを再実行してください。

### パーミッション付与時のアプリクラッシュ

**音声認識**や**マイク**のアクセスを許可しようとした際にアプリがクラッシュする場合、TCCキャッシュの破損または署名の不一致が原因の可能性があります。

**修正方法：**

1. TCCパーミッションをリセットします：

   ```bash
   tccutil reset All ai.openclaw.mac.debug
   ```

2. それでも解決しない場合は、[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)の`BUNDLE_ID`を一時的に変更して、macOSから「クリーンな状態」を強制します。

### Gatewayが「Starting...」のまま

Gatewayのステータスが「Starting...」のままの場合、ゾンビプロセスがポートを占有していないか確認してください：

```bash
openclaw gateway status
openclaw gateway stop

# LaunchAgentを使用していない場合（開発モード/手動実行）、リスナーを特定します：
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

手動実行がポートを占有している場合は、そのプロセスを停止してください（Ctrl+C）。最終手段として、上記で見つけたPIDをkillしてください。
