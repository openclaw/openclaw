---
summary: "「openclaw browser」の CLI リファレンス（プロファイル、タブ、アクション、拡張機能リレー）"
read_when:
  - 「openclaw browser」を使用しており、一般的なタスクの例を探している場合
  - ノード ホスト経由で別のマシン上で実行中のブラウザーを制御したい場合
  - Chrome 拡張機能リレーを使用したい場合（ツールバー ボタンによるアタッチ／デタッチ）
title: "ブラウザー"
---

# `openclaw browser`

OpenClaw のブラウザー制御サーバーを管理し、ブラウザー アクション（タブ、スナップショット、スクリーンショット、ナビゲーション、クリック、入力）を実行します。

関連項目:

- ブラウザー ツール + API: [Browser tool](/tools/browser)
- Chrome 拡張機能リレー: [Chrome extension](/tools/chrome-extension)

## Common flags

- `--url <gatewayWsUrl>`: Gateway WebSocket URL（既定は設定）。
- `--token <token>`: Gateway トークン（必要な場合）。
- `--timeout <ms>`: リクエスト タイムアウト（ms）。
- `--browser-profile <name>`: ブラウザー プロファイルを選択（既定は設定から）。
- `--json`: 機械可読な出力（対応している場合）。

## クイックスタート（ローカル）

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## プロファイル

プロファイルは、名前付きのブラウザー ルーティング設定です。実際には次のとおりです。 実際に：

- `openclaw`: OpenClaw が管理する専用の Chrome インスタンスを起動／アタッチします（分離されたユーザー データ ディレクトリ）。
- `chrome`: Chrome 拡張機能リレーを介して、既存の Chrome タブを制御します。

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

特定のプロファイルを使用する場合:

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

## スナップショット／スクリーンショット／アクション

スナップショット:

```bash
openclaw browser snapshot
```

スクリーンショット:

```bash
openclaw browser screenshot
```

ナビゲーション／クリック／入力（参照ベースの UI 自動化）:

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome 拡張機能リレー（ツールバー ボタンでアタッチ）

このモードでは、手動でアタッチした既存の Chrome タブをエージェントが制御できます（自動アタッチは行いません）。

展開済み拡張機能を安定したパスにインストールします。

```bash
openclaw browser extension install
openclaw browser extension path
```

次に、Chrome → `chrome://extensions` → 「Developer mode」を有効化 → 「Load unpacked」 → 表示されたフォルダーを選択します。

完全なガイド: [Chrome extension](/tools/chrome-extension)

## リモート ブラウザー制御（ノード ホスト プロキシ）

Gateway がブラウザーとは別のマシンで実行されている場合、Chrome／Brave／Edge／Chromium があるマシンで **node host** を実行します。Gateway はそのノードにブラウザー アクションをプロキシします（別途ブラウザー制御サーバーは不要です）。 ゲートウェイは、そのノードに対してプロキシブラウザアクションを実行します(個別のブラウザ制御サーバーは必要ありません)。

自動ルーティングの制御には `gateway.nodes.browser.mode` を使用し、複数のノードが接続されている場合に特定のノードへ固定するには `gateway.nodes.browser.node` を使用します。

セキュリティ + リモート セットアップ: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
