---
read_when:
    - macOS開発環境をセットアップする
summary: OpenClaw macOSアプリの開発者向けセットアップガイド
title: macOS開発セットアップ
x-i18n:
    generated_at: "2026-04-02T07:47:43Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d002d5c9088bcb37ec4851fd76fb41bbb12b2200cba3133644dbc59c28b77144
    source_path: platforms/mac/dev-setup.md
    workflow: 15
---

# macOS開発者セットアップ

このガイドでは、OpenClaw macOSアプリケーションをソースからビルドして実行するために必要な手順を説明します。

## 前提条件

アプリをビルドする前に、以下がインストールされていることを確認してください:

1. **Xcode 26.2+**: Swift開発に必要です。
2. **Node.js 24 & pnpm**: Gateway ゲートウェイ、CLI、パッケージングスクリプトに推奨されます。Node 22 LTS（現在 `22.14+`）も互換性のためサポートされています。

## 1. 依存関係のインストール

プロジェクト全体の依存関係をインストールします:

```bash
pnpm install
```

## 2. アプリのビルドとパッケージング

macOSアプリをビルドして `dist/OpenClaw.app` にパッケージングするには、以下を実行します:

```bash
./scripts/package-mac-app.sh
```

Apple Developer ID証明書がない場合、スクリプトは自動的に**アドホック署名**（`-`）を使用します。

開発実行モード、署名フラグ、Team IDのトラブルシューティングについては、macOSアプリのREADMEを参照してください:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **注意**: アドホック署名されたアプリはセキュリティプロンプトが表示されることがあります。アプリが「Abort trap 6」で即座にクラッシュする場合は、[トラブルシューティング](#troubleshooting)セクションを参照してください。

## 3. CLIのインストール

macOSアプリは、バックグラウンドタスクを管理するためにグローバルな `openclaw` CLIインストールを必要とします。

**インストール方法（推奨）:**

1. OpenClawアプリを開きます。
2. **General**設定タブに移動します。
3. **「Install CLI」**をクリックします。

または、手動でインストールします:

```bash
npm install -g openclaw@<version>
```

## トラブルシューティング

### ビルド失敗: ツールチェーンまたはSDKの不一致

macOSアプリのビルドには、最新のmacOS SDKとSwift 6.2ツールチェーンが必要です。

**システム依存関係（必須）:**

- **ソフトウェア・アップデートで利用可能な最新のmacOSバージョン**（Xcode 26.2 SDKに必要）
- **Xcode 26.2**（Swift 6.2ツールチェーン）

**確認方法:**

```bash
xcodebuild -version
xcrun swift --version
```

バージョンが一致しない場合は、macOS/Xcodeを更新してビルドを再実行してください。

### 権限付与時にアプリがクラッシュする

**音声認識**または**マイク**アクセスを許可しようとした際にアプリがクラッシュする場合、TCCキャッシュの破損または署名の不一致が原因の可能性があります。

**修正方法:**

1. TCC権限をリセットします:

   ```bash
   tccutil reset All ai.openclaw.mac.debug
   ```

2. それでも解決しない場合は、[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) の `BUNDLE_ID` を一時的に変更して、macOSに「クリーンな状態」を強制させます。

### Gateway ゲートウェイが「Starting...」のまま停止する

Gateway ゲートウェイのステータスが「Starting...」のままの場合、ゾンビプロセスがポートを占有していないか確認してください:

```bash
openclaw gateway status
openclaw gateway stop

# If you're not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

手動実行がポートを占有している場合は、そのプロセスを停止してください（Ctrl+C）。最終手段として、上記で見つけたPIDをkillしてください。
