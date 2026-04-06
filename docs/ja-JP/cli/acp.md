---
read_when:
    - ACPベースのIDE連携をセットアップする
    - Gateway ゲートウェイへのACPセッションルーティングをデバッグする
summary: IDE連携用のACPブリッジを実行する
title: acp
x-i18n:
    generated_at: "2026-04-02T07:33:19Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 1ee864216c20fb3b31cf0cbb5fa394d76ec8d198554d5519842e4498ae72ce69
    source_path: cli/acp.md
    workflow: 15
---

# acp

OpenClaw Gateway ゲートウェイと通信する [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) ブリッジを実行します。

このコマンドはIDEとstdio経由でACPを通信し、プロンプトをWebSocket経由で Gateway ゲートウェイに転送します。ACPセッションを Gateway ゲートウェイのセッションキーにマッピングした状態を維持します。

`openclaw acp` は Gateway ゲートウェイを利用するACPブリッジであり、完全なACPネイティブのエディターランタイムではありません。セッションルーティング、プロンプト配信、基本的なストリーミング更新に焦点を当てています。

外部のMCPクライアントがACPハーネスセッションをホストするのではなく、OpenClaw チャネルの会話と直接通信したい場合は、代わりに [`openclaw mcp serve`](/cli/mcp) を使用してください。

## 互換性マトリクス

| ACP領域                                                               | ステータス  | 備考                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`、`newSession`、`prompt`、`cancel`                        | 実装済み    | stdio経由で Gateway ゲートウェイの chat/send + abort へのコアブリッジフロー。                                                                                                                                                                      |
| `listSessions`、スラッシュコマンド                                     | 実装済み    | セッション一覧は Gateway ゲートウェイのセッション状態に対して動作します。コマンドは `available_commands_update` を介してアドバタイズされます。                                                                                                        |
| `loadSession`                                                         | 部分的      | ACPセッションを Gateway ゲートウェイのセッションキーに再バインドし、保存されたユーザー/アシスタントのテキスト履歴を再生します。ツール/システム履歴はまだ再構築されません。                                                                              |
| プロンプトコンテンツ（`text`、埋め込み `resource`、画像）                | 部分的      | テキスト/リソースはチャット入力にフラット化されます。画像は Gateway ゲートウェイの添付ファイルになります。                                                                                                                                           |
| セッションモード                                                       | 部分的      | `session/set_mode` がサポートされ、ブリッジは思考レベル、ツール詳細度、推論、使用量詳細、昇格アクションに関する初期の Gateway ゲートウェイベースのセッションコントロールを公開します。より広範なACPネイティブのモード/設定サーフェスはまだ対象外です。    |
| セッション情報と使用量の更新                                            | 部分的      | ブリッジはキャッシュされた Gateway ゲートウェイのセッションスナップショットから `session_info_update` とベストエフォートの `usage_update` 通知を送信します。使用量は概算であり、Gateway ゲートウェイのトークン合計がフレッシュとマークされた場合にのみ送信されます。 |
| ツールストリーミング                                                    | 部分的      | `tool_call` / `tool_call_update` イベントには生のI/O、テキストコンテンツ、および Gateway ゲートウェイのツール引数/結果で公開される場合のベストエフォートのファイル位置が含まれます。埋め込みターミナルやよりリッチなdiffネイティブ出力はまだ公開されていません。 |
| セッションごとのMCPサーバー（`mcpServers`）                             | 未サポート  | ブリッジモードはセッションごとのMCPサーバーリクエストを拒否します。代わりに OpenClaw Gateway ゲートウェイまたはエージェントでMCPを設定してください。                                                                                                  |
| クライアントファイルシステムメソッド（`fs/read_text_file`、`fs/write_text_file`） | 未サポート  | ブリッジはACPクライアントのファイルシステムメソッドを呼び出しません。                                                                                                                                                                               |
| クライアントターミナルメソッド（`terminal/*`）                          | 未サポート  | ブリッジはACPクライアントターミナルを作成せず、ツールコールを通じてターミナルIDをストリーミングしません。                                                                                                                                              |
| セッションプラン / 思考ストリーミング                                   | 未サポート  | ブリッジは現在、出力テキストとツールステータスを送信し、ACPプランや思考の更新は送信しません。                                                                                                                                                          |

## 既知の制限事項

- `loadSession` は保存されたユーザーとアシスタントのテキスト履歴を再生しますが、過去のツールコール、システム通知、またはよりリッチなACPネイティブのイベントタイプは再構築しません。
- 複数のACPクライアントが同じ Gateway ゲートウェイのセッションキーを共有する場合、イベントとキャンセルのルーティングはクライアントごとに厳密に分離されるのではなく、ベストエフォートです。クリーンなエディターローカルのターンが必要な場合は、デフォルトの分離された `acp:<uuid>` セッションを使用してください。
- Gateway ゲートウェイの停止状態はACPの停止理由に変換されますが、そのマッピングは完全にACPネイティブなランタイムほど表現力がありません。
- 初期のセッションコントロールは現在、Gateway ゲートウェイのノブの一部にフォーカスしたサブセットを公開しています：思考レベル、ツール詳細度、推論、使用量詳細、昇格アクション。モデル選択と実行ホストのコントロールはまだACPの設定オプションとして公開されていません。
- `session_info_update` と `usage_update` は、ライブのACPネイティブランタイムアカウンティングではなく、Gateway ゲートウェイのセッションスナップショットから導出されます。使用量は概算であり、コストデータを含まず、Gateway ゲートウェイがトータルトークンデータをフレッシュとマークした場合にのみ送信されます。
- ツールのフォローアロングデータはベストエフォートです。ブリッジは既知のツール引数/結果に現れるファイルパスを表示できますが、ACPターミナルや構造化されたファイルdiffはまだ送信しません。

## 使い方

```bash
openclaw acp

# リモート Gateway ゲートウェイ
openclaw acp --url wss://gateway-host:18789 --token <token>

# リモート Gateway ゲートウェイ（ファイルからトークンを読み取り）
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# 既存のセッションキーにアタッチ
openclaw acp --session agent:main:main

# ラベルでアタッチ（既に存在している必要があります）
openclaw acp --session-label "support inbox"

# 最初のプロンプト前にセッションキーをリセット
openclaw acp --session agent:main:main --reset-session
```

## ACPクライアント（デバッグ）

IDEなしでブリッジの動作を確認するために、組み込みのACPクライアントを使用します。
ACPブリッジを起動し、対話的にプロンプトを入力できます。

```bash
openclaw acp client

# 起動されたブリッジをリモート Gateway ゲートウェイに向ける
openclaw acp client --server-args --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# サーバーコマンドをオーバーライド（デフォルト: openclaw）
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

権限モデル（クライアントデバッグモード）：

- 自動承認はアローリストベースで、信頼されたコアツールIDにのみ適用されます。
- `read` の自動承認は現在の作業ディレクトリ（`--cwd` が設定されている場合はそれ）にスコープされます。
- ACPは限定的な読み取り専用クラスのみを自動承認します：アクティブなcwd配下のスコープ付き `read` 呼び出しと、読み取り専用の検索ツール（`search`、`web_search`、`memory_search`）。不明な/非コアツール、スコープ外の読み取り、実行可能なツール、コントロールプレーンツール、変更を伴うツール、インタラクティブなフローは常に明示的なプロンプト承認が必要です。
- サーバーが提供する `toolCall.kind` は信頼されないメタデータとして扱われます（認可ソースではありません）。
- このACPブリッジポリシーはACPXハーネス権限とは別です。OpenClaw を `acpx` バックエンドで実行する場合、`plugins.entries.acpx.config.permissionMode=approve-all` はそのハーネスセッション用のブレークグラス「yolo」スイッチです。

## 使い方

IDE（またはその他のクライアント）がAgent Client Protocolを使用し、OpenClaw Gateway ゲートウェイのセッションを操作したい場合にACPを使用します。

1. Gateway ゲートウェイが実行中であることを確認します（ローカルまたはリモート）。
2. Gateway ゲートウェイのターゲットを設定します（設定またはフラグ）。
3. IDEが stdio 経由で `openclaw acp` を実行するように設定します。

設定例（永続化）：

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

直接実行の例（設定の書き込みなし）：

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
# ローカルプロセスの安全性のために推奨
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token
```

## エージェントの選択

ACPはエージェントを直接選択しません。Gateway ゲートウェイのセッションキーによってルーティングします。

特定のエージェントをターゲットするには、エージェントスコープのセッションキーを使用します：

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

各ACPセッションは単一の Gateway ゲートウェイセッションキーにマッピングされます。1つのエージェントに複数のセッションを持つことができます。キーまたはラベルをオーバーライドしない限り、ACPはデフォルトで分離された `acp:<uuid>` セッションを使用します。

セッションごとの `mcpServers` はブリッジモードではサポートされていません。ACPクライアントが `newSession` または `loadSession` 中にそれらを送信した場合、ブリッジはサイレントに無視するのではなく、明確なエラーを返します。

ACPXベースのセッションで OpenClaw プラグインツールを表示したい場合は、セッションごとの `mcpServers` を渡そうとするのではなく、Gateway ゲートウェイ側のACPXプラグインブリッジを有効にしてください。[ACPエージェント](/tools/acp-agents#plugin-tools-mcp-bridge)を参照してください。

## `acpx` からの使用（Codex、Claude、その他のACPクライアント）

CodexやClaude Codeなどのコーディングエージェントに、ACP経由で OpenClaw ボットと通信させたい場合は、組み込みの `openclaw` ターゲットを持つ `acpx` を使用します。

一般的なフロー：

1. Gateway ゲートウェイを実行し、ACPブリッジが到達できることを確認します。
2. `acpx openclaw` を `openclaw acp` に向けます。
3. コーディングエージェントに使用させたい OpenClaw セッションキーをターゲットします。

例：

```bash
# デフォルトの OpenClaw ACPセッションへのワンショットリクエスト
acpx openclaw exec "Summarize the active OpenClaw session state."

# フォローアップターン用の永続的な名前付きセッション
acpx openclaw sessions ensure --name codex-bridge
acpx openclaw -s codex-bridge --cwd /path/to/repo \
  "Ask my OpenClaw work agent for recent context relevant to this repo."
```

`acpx openclaw` が毎回特定の Gateway ゲートウェイとセッションキーをターゲットするようにしたい場合は、`~/.acpx/config.json` で `openclaw` エージェントコマンドをオーバーライドします：

```json
{
  "agents": {
    "openclaw": {
      "command": "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main"
    }
  }
}
```

リポジトリローカルの OpenClaw チェックアウトの場合、ACPストリームをクリーンに保つために、devランナーではなく直接のCLIエントリーポイントを使用してください。例：

```bash
env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 node openclaw.mjs acp ...
```

これは、Codex、Claude Code、またはその他のACP対応クライアントがターミナルをスクレイピングせずに OpenClaw エージェントからコンテキスト情報を取得する最も簡単な方法です。

## Zedエディターのセットアップ

`~/.config/zed/settings.json` にカスタムACPエージェントを追加します（またはZedの設定UIを使用します）：

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

特定の Gateway ゲートウェイまたはエージェントをターゲットする場合：

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

Zedでエージェントパネルを開き、「OpenClaw ACP」を選択してスレッドを開始します。

## セッションマッピング

デフォルトでは、ACPセッションは `acp:` プレフィックス付きの分離された Gateway ゲートウェイセッションキーを取得します。
既知のセッションを再利用するには、セッションキーまたはラベルを渡します：

- `--session <key>`：特定の Gateway ゲートウェイセッションキーを使用します。
- `--session-label <label>`：ラベルで既存のセッションを解決します。
- `--reset-session`：そのキーに対して新しいセッションIDを発行します（同じキー、新しいトランスクリプト）。

ACPクライアントがメタデータをサポートしている場合、セッションごとにオーバーライドできます：

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

セッションキーの詳細については [/concepts/session](/concepts/session) を参照してください。

## オプション

- `--url <url>`：Gateway ゲートウェイの WebSocket URL（設定時は gateway.remote.url をデフォルトとします）。
- `--token <token>`：Gateway ゲートウェイの認証トークン。
- `--token-file <path>`：ファイルから Gateway ゲートウェイの認証トークンを読み取ります。
- `--password <password>`：Gateway ゲートウェイの認証パスワード。
- `--password-file <path>`：ファイルから Gateway ゲートウェイの認証パスワードを読み取ります。
- `--session <key>`：デフォルトのセッションキー。
- `--session-label <label>`：解決するデフォルトのセッションラベル。
- `--require-existing`：セッションキー/ラベルが存在しない場合に失敗します。
- `--reset-session`：最初の使用前にセッションキーをリセットします。
- `--no-prefix-cwd`：プロンプトに作業ディレクトリをプレフィックスしません。
- `--verbose, -v`：stderrへの詳細ログ。

セキュリティに関する注意：

- `--token` と `--password` は一部のシステムでローカルプロセス一覧に表示される可能性があります。
- `--token-file`/`--password-file` または環境変数（`OPENCLAW_GATEWAY_TOKEN`、`OPENCLAW_GATEWAY_PASSWORD`）の使用を推奨します。
- Gateway ゲートウェイの認証解決は、他の Gateway ゲートウェイクライアントが使用する共有コントラクトに従います：
  - ローカルモード：env（`OPENCLAW_GATEWAY_*`）→ `gateway.auth.*` → `gateway.remote.*` フォールバック（`gateway.auth.*` が未設定の場合のみ。設定済みだが未解決のローカル SecretRef はクローズドで失敗します）
  - リモートモード：`gateway.remote.*`（リモート優先順位ルールに基づく env/config フォールバック付き）
  - `--url` はオーバーライドセーフであり、暗黙の config/env 資格情報を再利用しません。明示的に `--token`/`--password`（またはファイルバリアント）を渡してください
- ACPランタイムバックエンドの子プロセスは `OPENCLAW_SHELL=acp` を受け取り、コンテキスト固有のシェル/プロファイルルールに使用できます。
- `openclaw acp client` は起動されたブリッジプロセスに `OPENCLAW_SHELL=acp-client` を設定します。

### `acp client` オプション

- `--cwd <dir>`：ACPセッションの作業ディレクトリ。
- `--server <command>`：ACPサーバーコマンド（デフォルト：`openclaw`）。
- `--server-args <args...>`：ACPサーバーに渡す追加の引数。
- `--server-verbose`：ACPサーバーの詳細ログを有効にします。
- `--verbose, -v`：クライアントの詳細ログ。
