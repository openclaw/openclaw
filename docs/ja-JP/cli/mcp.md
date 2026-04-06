---
read_when:
    - Codex、Claude Code、または他のMCPクライアントをOpenClaw連携チャネルに接続する場合
    - '`openclaw mcp serve`を実行する場合'
    - OpenClawの保存済みMCPサーバー定義を管理する場合
summary: OpenClawのチャネル会話をMCP経由で公開し、保存済みMCPサーバー定義を管理する
title: mcp
x-i18n:
    generated_at: "2026-04-02T07:35:23Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 26b9c5be4b7fdde1a16cdc46d9d0b7fa29aaf0692406f839f1fd7b7672e12a14
    source_path: cli/mcp.md
    workflow: 15
---

# mcp

`openclaw mcp`には2つの役割があります：

- `openclaw mcp serve`でOpenClawをMCPサーバーとして実行する
- `list`、`show`、`set`、`unset`でOpenClawが管理するアウトバウンドMCPサーバー定義を管理する

言い換えると：

- `serve`はOpenClawがMCPサーバーとして動作する機能
- `list` / `show` / `set` / `unset`はOpenClawが他のMCPサーバーのMCPクライアント側レジストリとして動作し、そのランタイムが後から利用する機能

OpenClaw自体がコーディングハーネスセッションをホストし、そのランタイムをACP経由でルーティングする場合は、[`openclaw acp`](/cli/acp)を使用してください。

## OpenClawをMCPサーバーとして使用する

これは`openclaw mcp serve`のパスです。

## `serve`を使用するタイミング

`openclaw mcp serve`は以下の場合に使用します：

- Codex、Claude Code、または他のMCPクライアントがOpenClaw連携チャネルの会話と直接通信する必要がある場合
- ローカルまたはリモートのOpenClaw Gateway ゲートウェイにルーティングされたセッションが既にある場合
- チャネルごとに個別のブリッジを実行する代わりに、OpenClawのチャネルバックエンド全体で動作する単一のMCPサーバーが必要な場合

OpenClaw自体がコーディングランタイムをホストし、エージェントセッションをOpenClaw内に保持する場合は、代わりに[`openclaw acp`](/cli/acp)を使用してください。

## 仕組み

`openclaw mcp serve`はstdio MCPサーバーを起動します。MCPクライアントがそのプロセスを所有します。クライアントがstdioセッションを開いている間、ブリッジはWebSocket経由でローカルまたはリモートのOpenClaw Gateway ゲートウェイに接続し、ルーティングされたチャネル会話をMCP経由で公開します。

ライフサイクル：

1. MCPクライアントが`openclaw mcp serve`を起動する
2. ブリッジがGateway ゲートウェイに接続する
3. ルーティングされたセッションがMCPの会話およびトランスクリプト/履歴ツールになる
4. ブリッジが接続されている間、ライブイベントがメモリ内にキューイングされる
5. Claudeチャネルモードが有効な場合、同じセッションでClaude固有のプッシュ通知も受信できる

重要な動作：

- ライブキューの状態はブリッジ接続時に開始される
- 過去のトランスクリプト履歴は`messages_read`で読み取る
- Claudeプッシュ通知はMCPセッションが生きている間のみ存在する
- クライアントが切断すると、ブリッジが終了しライブキューは消失する

## クライアントモードの選択

同じブリッジを2つの異なる方法で使用できます：

- 汎用MCPクライアント：標準MCPツールのみ。`conversations_list`、`messages_read`、`events_poll`、`events_wait`、`messages_send`、および承認ツールを使用します。
- Claude Code：標準MCPツールに加え、Claude固有のチャネルアダプター。`--claude-channel-mode on`を有効にするか、デフォルトの`auto`のままにします。

現在、`auto`は`on`と同じ動作をします。クライアント機能の検出はまだ実装されていません。

## `serve`が公開する内容

ブリッジは既存のGateway ゲートウェイセッションルートメタデータを使用して、チャネル連携の会話を公開します。OpenClawが以下のような既知のルートを持つセッション状態を既に持っている場合に会話が表示されます：

- `channel`
- 受信者または宛先メタデータ
- オプションの`accountId`
- オプションの`threadId`

これにより、MCPクライアントは1つの場所で以下のことができます：

- 最近のルーティングされた会話を一覧表示する
- 最近のトランスクリプト履歴を読み取る
- 新しい受信イベントを待機する
- 同じルート経由で返信を送信する
- ブリッジ接続中に到着した承認リクエストを確認する

## 使い方

```bash
# ローカルGateway ゲートウェイ
openclaw mcp serve

# リモートGateway ゲートウェイ
openclaw mcp serve --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# パスワード認証によるリモートGateway ゲートウェイ
openclaw mcp serve --url wss://gateway-host:18789 --password-file ~/.openclaw/gateway.password

# 詳細なブリッジログを有効にする
openclaw mcp serve --verbose

# Claude固有のプッシュ通知を無効にする
openclaw mcp serve --claude-channel-mode off
```

## ブリッジツール

現在のブリッジは以下のMCPツールを公開しています：

- `conversations_list`
- `conversation_get`
- `messages_read`
- `attachments_fetch`
- `events_poll`
- `events_wait`
- `messages_send`
- `permissions_list_open`
- `permissions_respond`

### `conversations_list`

Gateway ゲートウェイのセッション状態にルートメタデータが既にある、最近のセッション連携会話を一覧表示します。

便利なフィルター：

- `limit`
- `search`
- `channel`
- `includeDerivedTitles`
- `includeLastMessage`

### `conversation_get`

`session_key`で1つの会話を返します。

### `messages_read`

1つのセッション連携会話の最近のトランスクリプトメッセージを読み取ります。

### `attachments_fetch`

1つのトランスクリプトメッセージからテキスト以外のメッセージコンテンツブロックを抽出します。これはトランスクリプトコンテンツに対するメタデータビューであり、独立した永続的な添付ファイルBlobストアではありません。

### `events_poll`

数値カーソル以降のキューイングされたライブイベントを読み取ります。

### `events_wait`

次の一致するキューイングされたイベントが到着するか、タイムアウトが期限切れになるまでロングポーリングします。

Claude固有のプッシュプロトコルなしで、汎用MCPクライアントがほぼリアルタイムの配信を必要とする場合に使用してください。

### `messages_send`

セッションに既に記録されている同じルート経由でテキストを送信します。

現在の動作：

- 既存の会話ルートが必要
- セッションのチャネル、受信者、アカウントID、スレッドIDを使用
- テキストのみ送信

### `permissions_list_open`

ブリッジがGateway ゲートウェイに接続してから検出した、保留中のexec/プラグイン承認リクエストを一覧表示します。

### `permissions_respond`

1つの保留中のexec/プラグイン承認リクエストを以下のいずれかで解決します：

- `allow-once`
- `allow-always`
- `deny`

## イベントモデル

ブリッジは接続中、メモリ内にイベントキューを保持します。

現在のイベントタイプ：

- `message`
- `exec_approval_requested`
- `exec_approval_resolved`
- `plugin_approval_requested`
- `plugin_approval_resolved`
- `claude_permission_request`

重要な制限事項：

- キューはライブ専用です。MCPブリッジの起動時に開始されます
- `events_poll`および`events_wait`は単独では過去のGateway ゲートウェイ履歴を再生しません
- 永続的なバックログは`messages_read`で読み取る必要があります

## Claudeチャネル通知

ブリッジはClaude固有のチャネル通知も公開できます。これはClaude Codeチャネルアダプターに相当するOpenClawの機能です。標準MCPツールは引き続き利用可能ですが、ライブの受信メッセージがClaude固有のMCP通知としても到着できます。

フラグ：

- `--claude-channel-mode off`：標準MCPツールのみ
- `--claude-channel-mode on`：Claudeチャネル通知を有効にする
- `--claude-channel-mode auto`：現在のデフォルト。`on`と同じブリッジ動作

Claudeチャネルモードが有効な場合、サーバーはClaude実験的機能をアドバタイズし、以下を発行できます：

- `notifications/claude/channel`
- `notifications/claude/channel/permission`

現在のブリッジ動作：

- 受信した`user`トランスクリプトメッセージは`notifications/claude/channel`として転送される
- MCP経由で受信したClaude権限リクエストはメモリ内で追跡される
- リンクされた会話が後から`yes abcde`または`no abcde`を送信すると、ブリッジはそれを`notifications/claude/channel/permission`に変換する
- これらの通知はライブセッション専用です。MCPクライアントが切断すると、プッシュ先がなくなります

これは意図的にクライアント固有の機能です。汎用MCPクライアントは標準のポーリングツールに依存すべきです。

## MCPクライアント設定

stdioクライアント設定の例：

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "openclaw",
      "args": [
        "mcp",
        "serve",
        "--url",
        "wss://gateway-host:18789",
        "--token-file",
        "/path/to/gateway.token"
      ]
    }
  }
}
```

ほとんどの汎用MCPクライアントでは、標準ツールサーフェスから始めてClaudeモードは無視してください。Claudeモードは、Claude固有の通知メソッドを実際に理解するクライアントに対してのみ有効にしてください。

## オプション

`openclaw mcp serve`は以下をサポートしています：

- `--url <url>`：Gateway ゲートウェイのWebSocket URL
- `--token <token>`：Gateway ゲートウェイトークン
- `--token-file <path>`：ファイルからトークンを読み取る
- `--password <password>`：Gateway ゲートウェイパスワード
- `--password-file <path>`：ファイルからパスワードを読み取る
- `--claude-channel-mode <auto|on|off>`：Claude通知モード
- `-v`、`--verbose`：stderrへの詳細ログ

可能な場合は、インラインシークレットよりも`--token-file`または`--password-file`を優先してください。

## セキュリティと信頼境界

ブリッジはルーティングを独自に生成しません。Gateway ゲートウェイが既にルーティング方法を把握している会話のみを公開します。

つまり：

- 送信者許可リスト、ペアリング、チャネルレベルの信頼は、基盤となるOpenClawチャネル設定に引き続き属します
- `messages_send`は既存の保存済みルート経由でのみ返信できます
- 承認状態は現在のブリッジセッションのライブ/メモリ内のみです
- ブリッジ認証は、他のリモートGateway ゲートウェイクライアントに対して信頼するのと同じGateway ゲートウェイトークンまたはパスワード制御を使用すべきです

会話が`conversations_list`に表示されない場合、通常の原因はMCP設定ではありません。基盤となるGateway ゲートウェイセッションのルートメタデータが欠落または不完全です。

## テスト

OpenClawはこのブリッジ用の決定論的なDockerスモークテストを提供しています：

```bash
pnpm test:docker:mcp-channels
```

このスモークテストは：

- シードされたGateway ゲートウェイコンテナを起動する
- `openclaw mcp serve`を起動する2番目のコンテナを起動する
- 会話のディスカバリー、トランスクリプトの読み取り、添付ファイルメタデータの読み取り、ライブイベントキューの動作、およびアウトバウンド送信ルーティングを検証する
- 実際のstdio MCPブリッジ経由でClaudeスタイルのチャネルおよび権限通知を検証する

これは、実際のTelegram、Discord、またはiMessageアカウントをテストに接続せずに、ブリッジの動作を証明する最速の方法です。

より広範なテストのコンテキストについては、[テスト](/help/testing)を参照してください。

## トラブルシューティング

### 会話が返されない

通常、Gateway ゲートウェイセッションがまだルーティング可能でないことを意味します。基盤となるセッションに保存済みのチャネル/プロバイダー、受信者、およびオプションのアカウント/スレッドルートメタデータがあることを確認してください。

### `events_poll`または`events_wait`が古いメッセージを取得しない

これは想定された動作です。ライブキューはブリッジ接続時に開始されます。過去のトランスクリプト履歴は`messages_read`で読み取ってください。

### Claude通知が表示されない

以下をすべて確認してください：

- クライアントがstdio MCPセッションを開いたままにしている
- `--claude-channel-mode`が`on`または`auto`である
- クライアントがClaude固有の通知メソッドを実際に理解している
- 受信メッセージがブリッジ接続後に発生した

### 承認が表示されない

`permissions_list_open`はブリッジ接続中に検出された承認リクエストのみを表示します。永続的な承認履歴APIではありません。

## OpenClawをMCPクライアントレジストリとして使用する

これは`openclaw mcp list`、`show`、`set`、`unset`のパスです。

これらのコマンドはOpenClawをMCP経由で公開しません。OpenClaw設定内の`mcp.servers`にあるOpenClawが管理するMCPサーバー定義を管理します。

これらの保存済み定義は、組み込みPiやその他のランタイムアダプターなど、OpenClawが後から起動または設定するランタイム用です。OpenClawは定義を一元管理することで、それらのランタイムが独自のMCPサーバーリストの重複を保持する必要がなくなります。

重要な動作：

- これらのコマンドはOpenClaw設定の読み取りまたは書き込みのみを行います
- ターゲットMCPサーバーには接続しません
- コマンド、URL、またはリモートトランスポートが現在到達可能かどうかは検証しません
- ランタイムアダプターは実行時にどのトランスポート形式を実際にサポートするかを決定します

## 保存済みMCPサーバー定義

OpenClawはOpenClawが管理するMCP定義を必要とするサーフェス向けに、軽量なMCPサーバーレジストリも設定内に保存しています。

コマンド：

- `openclaw mcp list`
- `openclaw mcp show [name]`
- `openclaw mcp set <name> <json>`
- `openclaw mcp unset <name>`

例：

```bash
openclaw mcp list
openclaw mcp show context7 --json
openclaw mcp set context7 '{"command":"uvx","args":["context7-mcp"]}'
openclaw mcp set docs '{"url":"https://mcp.example.com"}'
openclaw mcp unset context7
```

設定形式の例：

```json
{
  "mcp": {
    "servers": {
      "context7": {
        "command": "uvx",
        "args": ["context7-mcp"]
      },
      "docs": {
        "url": "https://mcp.example.com"
      }
    }
  }
}
```

### Stdioトランスポート

ローカルの子プロセスを起動し、stdin/stdout経由で通信します。

| フィールド                      | 説明                       |
| -------------------------- | --------------------------------- |
| `command`                  | 起動する実行ファイル（必須）    |
| `args`                     | コマンドライン引数の配列   |
| `env`                      | 追加の環境変数       |
| `cwd` / `workingDirectory` | プロセスの作業ディレクトリ |

### SSE / HTTPトランスポート

HTTP Server-Sent Events経由でリモートMCPサーバーに接続します。

| フィールド               | 説明                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `url`               | リモートサーバーのHTTPまたはHTTPS URL（必須）                |
| `headers`           | オプションのHTTPヘッダーのキーバリューマップ（例：認証トークン） |
| `connectionTimeout` | サーバーごとの接続タイムアウト（ミリ秒、オプション）                   |

例：

```json
{
  "mcp": {
    "servers": {
      "remote-tools": {
        "url": "https://mcp.example.com",
        "headers": {
          "Authorization": "Bearer <token>"
        }
      }
    }
  }
}
```

`url`（ユーザー情報）および`headers`内の機密値はログとステータス出力で編集されます。

### ストリーマブルHTTPトランスポート

`streamable-http`は`sse`および`stdio`に加えた追加のトランスポートオプションです。リモートMCPサーバーとの双方向通信にHTTPストリーミングを使用します。

| フィールド               | 説明                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `url`               | リモートサーバーのHTTPまたはHTTPS URL（必須）                |
| `transport`         | このトランスポートを選択するには`"streamable-http"`に設定              |
| `headers`           | オプションのHTTPヘッダーのキーバリューマップ（例：認証トークン） |
| `connectionTimeout` | サーバーごとの接続タイムアウト（ミリ秒、オプション）                   |

例：

```json
{
  "mcp": {
    "servers": {
      "streaming-tools": {
        "url": "https://mcp.example.com/stream",
        "transport": "streamable-http",
        "connectionTimeout": 10000,
        "headers": {
          "Authorization": "Bearer <token>"
        }
      }
    }
  }
}
```

これらのコマンドは保存済み設定の管理のみを行います。チャネルブリッジの起動、ライブMCPクライアントセッションの開始、ターゲットサーバーの到達可能性の検証は行いません。

## 現在の制限事項

このページは現時点で提供されているブリッジについて説明しています。

現在の制限事項：

- 会話のディスカバリーは既存のGateway ゲートウェイセッションルートメタデータに依存します
- Claude固有のアダプター以外の汎用プッシュプロトコルはありません
- メッセージの編集やリアクションツールはまだありません
- HTTP/SSE/ストリーマブルHTTPトランスポートは単一のリモートサーバーに接続します。多重化されたアップストリームはまだありません
- `permissions_list_open`はブリッジ接続中に検出された承認のみを含みます
