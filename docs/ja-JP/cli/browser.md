---
summary: "`openclaw browser` のCLIリファレンス（プロファイル、タブ、アクション、拡張機能リレー）"
read_when:
  - "`openclaw browser` を使用して一般的なタスクの例を確認したい場合"
  - ノードホスト経由で別のマシンで実行中のブラウザを制御したい場合
  - Chrome拡張機能リレー（ツールバーボタンからアタッチ/デタッチ）を使用したい場合
title: "browser"
---

# `openclaw browser`

OpenClawのブラウザコントロールサーバーを管理し、ブラウザアクション（タブ、スナップショット、スクリーンショット、ナビゲーション、クリック、タイピング）を実行します。

関連：

- ブラウザツール + API：[Browser tool](/tools/browser)
- Chrome拡張機能リレー：[Chrome extension](/tools/chrome-extension)

## 共通フラグ

- `--url <gatewayWsUrl>`: Gateway WebSocket URL（設定からのデフォルト）。
- `--token <token>`: Gatewayトークン（必要な場合）。
- `--timeout <ms>`: リクエストタイムアウト（ミリ秒）。
- `--browser-profile <name>`: ブラウザプロファイルを選択（設定からのデフォルト）。
- `--json`: 機械可読出力（サポートされている場合）。

## クイックスタート（ローカル）

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## プロファイル

プロファイルは名前付きブラウザルーティング設定です。実際には：

- `openclaw`: 専用のOpenClaw管理Chromeインスタンス（分離されたユーザーデータディレクトリ）を起動/アタッチします。
- `chrome`: Chrome拡張機能リレーを使用して、既存のChromeタブを制御します。

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

特定のプロファイルを使用：

```bash
openclaw browser --browser-profile work tabs
```

## タブ

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## スナップショット / スクリーンショット / アクション

スナップショット：

```bash
openclaw browser snapshot
```

スクリーンショット：

```bash
openclaw browser screenshot
```

ナビゲーション/クリック/タイプ（refベースのUI自動化）：

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome拡張機能リレー（ツールバーボタンからアタッチ）

このモードでは、手動でアタッチした既存のChromeタブをエージェントが制御できます（自動アタッチはしません）。

安定したパスにアンパック拡張機能をインストール：

```bash
openclaw browser extension install
openclaw browser extension path
```

その後、Chrome → `chrome://extensions` → 「デベロッパーモード」を有効化 → 「パッケージ化されていない拡張機能を読み込む」→ 表示されたフォルダーを選択します。

完全ガイド：[Chrome extension](/tools/chrome-extension)

## リモートブラウザコントロール（ノードホストプロキシ）

Gatewayがブラウザとは別のマシンで実行されている場合、Chrome/Brave/Edge/Chromiumがあるマシンで**ノードホスト**を実行します。Gatewayはブラウザアクションをそのノードにプロキシします（別途ブラウザコントロールサーバーは不要です）。

`gateway.nodes.browser.mode` で自動ルーティングを制御し、複数のノードが接続されている場合は `gateway.nodes.browser.node` で特定のノードを固定します。

セキュリティ + リモートセットアップ：[Browser tool](/tools/browser)、[Remote access](/gateway/remote)、[Tailscale](/gateway/tailscale)、[Security](/gateway/security)
