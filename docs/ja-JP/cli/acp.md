---
summary: "IDE統合のためのACPブリッジを実行します"
read_when:
  - ACPベースのIDE統合をセットアップする場合
  - ACPセッションのGatewayへのルーティングをデバッグする場合
title: "acp"
---

# acp

OpenClaw Gatewayと通信する[Agent Client Protocol (ACP)](https://agentclientprotocol.com/)ブリッジを実行します。

このコマンドはIDE向けにstdio経由でACPを使用し、プロンプトをWebSocket経由でGatewayに転送します。ACPセッションをGatewayセッションキーにマッピングします。

## 使い方

```bash
openclaw acp

# リモートGateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# リモートGateway（ファイルからトークンを読み取り）
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# 既存のセッションキーにアタッチ
openclaw acp --session agent:main:main

# ラベルでアタッチ（既に存在している必要があります）
openclaw acp --session-label "support inbox"

# 最初のプロンプトの前にセッションキーをリセット
openclaw acp --session agent:main:main --reset-session
```

## ACPクライアント（デバッグ）

IDEなしでブリッジの動作確認を行うための組み込みACPクライアントを使用します。
ACPブリッジを起動し、対話的にプロンプトを入力できます。

```bash
openclaw acp client

# 起動したブリッジをリモートGatewayに接続
openclaw acp client --server-args --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# サーバーコマンドを上書き（デフォルト: openclaw）
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

パーミッションモデル（クライアントデバッグモード）：

- 自動承認は許可リストベースで、信頼されたコアツールIDにのみ適用されます。
- `read` の自動承認は、現在の作業ディレクトリ（`--cwd` 設定時）にスコープされます。
- 不明/非コアツール名、スコープ外の読み取り、および危険なツールは常に明示的なプロンプト承認が必要です。
- サーバー提供の `toolCall.kind` は信頼されないメタデータとして扱われます（認可ソースではありません）。

## 使用方法

IDE（またはその他のクライアント）がAgent Client Protocolを使用し、OpenClaw Gatewayセッションを操作したい場合にACPを使用します。

1. Gatewayが実行中であることを確認します（ローカルまたはリモート）。
2. Gatewayのターゲットを設定します（設定またはフラグ）。
3. IDEが `openclaw acp` をstdio経由で実行するよう設定します。

設定例（永続化）：

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

直接実行の例（設定書き込みなし）：

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
# ローカルプロセスの安全性のために推奨
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token
```

## エージェントの選択

ACPはエージェントを直接選択しません。Gatewayセッションキーによってルーティングします。

エージェントスコープのセッションキーを使用して、特定のエージェントを指定します：

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

各ACPセッションは単一のGatewayセッションキーにマッピングされます。1つのエージェントが複数のセッションを持つことができます。ACPは、キーまたはラベルを上書きしない限り、分離された `acp:<uuid>` セッションをデフォルトで使用します。

## Zedエディタのセットアップ

`~/.config/zed/settings.json` にカスタムACPエージェントを追加します（またはZedの設定UIを使用）：

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

特定のGatewayまたはエージェントを指定する場合：

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

Zedで、Agentパネルを開き「OpenClaw ACP」を選択してスレッドを開始します。

## セッションマッピング

デフォルトでは、ACPセッションは `acp:` プレフィックス付きの分離されたGatewayセッションキーを取得します。
既知のセッションを再利用するには、セッションキーまたはラベルを渡します：

- `--session <key>`: 特定のGatewayセッションキーを使用します。
- `--session-label <label>`: 既存のセッションをラベルで解決します。
- `--reset-session`: そのキーの新しいセッションIDを発行します（同じキー、新しいトランスクリプト）。

ACPクライアントがメタデータをサポートしている場合、セッションごとに上書きできます：

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

セッションキーの詳細については[/concepts/session](/concepts/session)を参照してください。

## オプション

- `--url <url>`: Gateway WebSocket URL（設定されている場合はgateway.remote.urlがデフォルト）。
- `--token <token>`: Gateway認証トークン。
- `--token-file <path>`: ファイルからGateway認証トークンを読み取ります。
- `--password <password>`: Gateway認証パスワード。
- `--password-file <path>`: ファイルからGateway認証パスワードを読み取ります。
- `--session <key>`: デフォルトのセッションキー。
- `--session-label <label>`: 解決するデフォルトのセッションラベル。
- `--require-existing`: セッションキー/ラベルが存在しない場合に失敗します。
- `--reset-session`: 最初の使用前にセッションキーをリセットします。
- `--no-prefix-cwd`: プロンプトに作業ディレクトリのプレフィックスを付けません。
- `--verbose, -v`: stderrへの詳細ログ出力。

セキュリティに関する注意：

- `--token` と `--password` は一部のシステムではローカルプロセスリストで表示される場合があります。
- `--token-file`/`--password-file` または環境変数（`OPENCLAW_GATEWAY_TOKEN`、`OPENCLAW_GATEWAY_PASSWORD`）の使用を推奨します。

### `acp client` オプション

- `--cwd <dir>`: ACPセッションの作業ディレクトリ。
- `--server <command>`: ACPサーバーコマンド（デフォルト: `openclaw`）。
- `--server-args <args...>`: ACPサーバーに渡す追加引数。
- `--server-verbose`: ACPサーバーの詳細ログを有効にします。
- `--verbose, -v`: クライアントの詳細ログ出力。
