---
summary: "IDE 統合のために ACP ブリッジを実行します"
read_when:
  - ACP ベースの IDE 統合をセットアップする場合
  - ACP セッションの Gateway へのルーティングをデバッグする場合
title: "acp"
---

# acp

OpenClaw Gateway（ゲートウェイ）と通信する ACP（Agent Client Protocol）ブリッジを実行します。

このコマンドは IDE 向けに stdio 経由で ACP を話し、プロンプトを WebSocket 経由で Gateway に転送します。ACP セッションは Gateway のセッションキーにマッピングされます。 ACP セッションは Gateway セッション キーにマップされます。

## Usage

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## ACP client（デバッグ）

組み込みの ACP クライアントを使用すると、IDE なしでブリッジの健全性を確認できます。
ACP ブリッジを起動し、対話的にプロンプトを入力できます。
ACP ブリッジを生成し、プロンプトをインタラクティブに入力できます。

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## How to use this

IDE（または他のクライアント）が Agent Client Protocol を話し、OpenClaw Gateway のセッションを駆動したい場合に ACP を使用します。

1. Gateway が稼働していること（ローカルまたはリモート）を確認します。
2. Gateway のターゲットを設定します（設定またはフラグ）。
3. IDE が stdio 経由で `openclaw acp` を実行するように指定します。

設定例（永続化）:

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

直接実行の例（設定を書き込まない）:

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selecting agents

ACP はエージェントを直接選択しません。Gateway のセッションキーでルーティングします。 ゲートウェイセッションキーによってルーティングされます。

特定のエージェントを対象にするには、エージェントスコープのセッションキーを使用します。

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

各 ACP セッションは、1 つの Gateway セッション キーにマップします。 各 ACP セッションは単一の Gateway セッションキーにマッピングされます。1 つのエージェントは多数のセッションを持てます。キーやラベルを上書きしない限り、ACP は分離された `acp:<uuid>` セッションをデフォルトで使用します。

## Zed editor setup

`~/.config/zed/settings.json` にカスタム ACP エージェントを追加します（または Zed の Settings UI を使用します）。

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

特定の Gateway やエージェントを対象にするには次を設定します。

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

Zed で Agent パネルを開き、「OpenClaw ACP」を選択してスレッドを開始します。

## Session mapping

デフォルトでは、ACP セッションには `acp:` プレフィックスを持つ分離された Gateway セッションキーが割り当てられます。
既知のセッションを再利用するには、セッションキーまたはラベルを指定します。
既知のセッションを再利用するには、セッションキーまたはラベルを渡します。

- `--session <key>`: 特定の Gateway セッションキーを使用します。
- `--session-label <label>`: ラベルで既存のセッションを解決します。
- `--reset-session`: そのキー用に新しいセッション ID を発行します（同じキーで新しいトランスクリプト）。

ACP クライアントがメタデータをサポートしている場合、セッションごとに上書きできます。

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

セッションキーの詳細は [/concepts/session](/concepts/session) を参照してください。

## Options

- `--url <url>`: Gateway WebSocket URL（設定されている場合は gateway.remote.url が既定）。
- `--token <token>`: Gateway 認証トークン。
- `--password <password>`: Gateway 認証パスワード。
- `--session <key>`: 既定のセッションキー。
- `--session-label <label>`: 解決する既定のセッションラベル。
- `--require-existing`: セッションキー／ラベルが存在しない場合に失敗します。
- `--reset-session`: 初回使用前にセッションキーをリセットします。
- `--no-prefix-cwd`: 作業ディレクトリでプロンプトをプレフィックスしません。
- `--verbose, -v`: stderr への詳細ログ。

### `acp client` options

- `--cwd <dir>`: ACP セッションの作業ディレクトリ。
- `--server <command>`: ACP サーバーコマンド（既定: `openclaw`）。
- `--server-args <args...>`: ACP サーバーに渡す追加引数。
- `--server-verbose`: ACP サーバーで詳細ログを有効化します。
- `--verbose, -v`: クライアントの詳細ログ。
