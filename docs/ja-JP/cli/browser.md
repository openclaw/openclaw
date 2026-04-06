---
read_when:
    - '`openclaw browser` を使用していて、一般的なタスクの例を知りたい場合'
    - ノードホスト経由で別のマシンで実行中のブラウザを制御したい場合
    - Chrome MCP経由でローカルのサインイン済みChromeにアタッチしたい場合
summary: '`openclaw browser` のCLIリファレンス（プロファイル、タブ、アクション、Chrome MCP、CDP）'
title: browser
x-i18n:
    generated_at: "2026-04-02T07:32:50Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 40ed9d9b52d392919f8f85ee240a55a7a51291d7e2a697dce6f79704fccc85ee
    source_path: cli/browser.md
    workflow: 15
---

# `openclaw browser`

OpenClawのブラウザ制御サーバーを管理し、ブラウザアクション（タブ、スナップショット、スクリーンショット、ナビゲーション、クリック、タイピング）を実行します。

関連：

- ブラウザツール + API：[ブラウザツール](/tools/browser)

## 共通フラグ

- `--url <gatewayWsUrl>`：Gateway ゲートウェイのWebSocket URL（デフォルトは設定から取得）。
- `--token <token>`：Gateway ゲートウェイのトークン（必要な場合）。
- `--timeout <ms>`：リクエストタイムアウト（ミリ秒）。
- `--browser-profile <name>`：ブラウザプロファイルを選択（デフォルトは設定から取得）。
- `--json`：機械可読な出力（サポートされている場合）。

## クイックスタート（ローカル）

```bash
openclaw browser profiles
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## コマンドが見つからない場合

`openclaw browser` が不明なコマンドの場合、`~/.openclaw/openclaw.json` の `plugins.allow` を確認してください。

`plugins.allow` が設定されている場合、バンドルされたブラウザプラグインを明示的にリストに含める必要があります：

```json5
{
  plugins: {
    allow: ["telegram", "browser"],
  },
}
```

プラグイン許可リストが `browser` を除外している場合、`browser.enabled=true` を設定してもCLIサブコマンドは復元されません。

関連：[ブラウザツール](/tools/browser#missing-browser-command-or-tool)

## プロファイル

プロファイルは名前付きのブラウザルーティング設定です。実際には：

- `openclaw`：専用のOpenClaw管理Chromeインスタンスを起動またはアタッチします（分離されたユーザーデータディレクトリ）。
- `user`：Chrome DevTools MCP経由で既存のサインイン済みChromeセッションを制御します。
- カスタムCDPプロファイル：ローカルまたはリモートのCDPエンドポイントを指定します。

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser create-profile --name chrome-live --driver existing-session
openclaw browser delete-profile --name work
```

特定のプロファイルを使用する場合：

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

ナビゲーション/クリック/タイピング（refベースのUI自動化）：

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## MCP経由で既存のChromeを使用

組み込みの `user` プロファイルを使用するか、独自の `existing-session` プロファイルを作成します：

```bash
openclaw browser --browser-profile user tabs
openclaw browser create-profile --name chrome-live --driver existing-session
openclaw browser create-profile --name brave-live --driver existing-session --user-data-dir "~/Library/Application Support/BraveSoftware/Brave-Browser"
openclaw browser --browser-profile chrome-live tabs
```

このパスはホスト専用です。Docker、ヘッドレスサーバー、Browserless、その他のリモートセットアップの場合は、代わりにCDPプロファイルを使用してください。

## リモートブラウザ制御（ノードホストプロキシ）

Gateway ゲートウェイがブラウザとは異なるマシンで実行されている場合、Chrome/Brave/Edge/Chromiumがあるマシンで**ノードホスト**を実行します。Gateway ゲートウェイはブラウザアクションをそのノードにプロキシします（別のブラウザ制御サーバーは不要です）。

`gateway.nodes.browser.mode` で自動ルーティングを制御し、複数のノードが接続されている場合は `gateway.nodes.browser.node` で特定のノードを固定します。

セキュリティ + リモートセットアップ：[ブラウザツール](/tools/browser)、[リモートアクセス](/gateway/remote)、[Tailscale](/gateway/tailscale)、[セキュリティ](/gateway/security)
