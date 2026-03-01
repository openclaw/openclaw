---
summary: "SSHトンネル（Gateway WS）とTailnetを使用したリモートアクセス"
read_when:
  - Running or troubleshooting remote gateway setups
title: "リモートアクセス"
---

# リモートアクセス（SSH、トンネル、Tailnet）

このリポジトリは、専用ホスト（デスクトップ/サーバー）で単一のGateway（マスター）を実行し、クライアントを接続することで「SSH経由のリモート」をサポートします。

- **オペレーター（あなた / macOSアプリ）向け**：SSHトンネリングが汎用フォールバックです。
- **ノード（iOS/Androidおよび将来のデバイス）向け**：Gateway **WebSocket**に接続します（必要に応じてLAN/Tailnetまたはトンネル経由）。

## コアアイデア

- Gateway WebSocketは設定されたポート（デフォルト18789）の**ループバック**にバインドされます。
- リモート使用では、SSH経由でそのループバックポートを転送します（またはTailnet/VPNを使用してトンネルを減らします）。

## 一般的なVPN/Tailnetセットアップ（エージェントが存在する場所）

**Gatewayホスト**を「エージェントが住む場所」と考えてください。セッション、認証プロファイル、チャンネル、状態を所有します。
あなたのラップトップ/デスクトップ（およびノード）がそのホストに接続します。

### 1) Tailnet内の常時稼働Gateway（VPSまたはホームサーバー）

永続ホストでGatewayを実行し、**Tailscale**またはSSH経由でアクセスします。

- **最良のUX：** `gateway.bind: "loopback"`を維持し、Control UIに**Tailscale Serve**を使用します。
- **フォールバック：** ループバック + アクセスが必要なマシンからのSSHトンネル。
- **例：** [exe.dev](/install/exe-dev)（簡単なVM）または[Hetzner](/install/hetzner)（本番VPS）。

ラップトップが頻繁にスリープするが、エージェントを常時稼働させたい場合に最適です。

### 2) 自宅デスクトップでGateway実行、ラップトップはリモートコントロール

ラップトップはエージェントを実行**しません**。リモートで接続します：

- macOSアプリの**Remote over SSH**モード（設定 → 一般 → 「OpenClawの実行場所」）を使用します。
- アプリがトンネルを開いて管理するため、WebChat + ヘルスチェックが「そのまま動作」します。

ランブック：[macOSリモートアクセス](/platforms/mac/remote)。

### 3) ラップトップでGateway実行、他のマシンからリモートアクセス

Gatewayをローカルに保ちますが、安全に公開します：

- 他のマシンからラップトップへのSSHトンネル、または
- Tailscale ServeでControl UIを提供し、Gatewayはループバックのみにします。

ガイド：[Tailscale](/gateway/tailscale)と[Web概要](/web)。

## コマンドフロー（どこで何が実行されるか）

1つのGatewayサービスが状態 + チャンネルを所有します。ノードはペリフェラルです。

フロー例（Telegram → ノード）：

- Telegramメッセージが**Gateway**に到着します。
- Gatewayが**エージェント**を実行し、ノードツールを呼び出すかどうかを決定します。
- GatewayがGateway WebSocket経由で**ノード**を呼び出します（`node.*` RPC）。
- ノードが結果を返し、GatewayがTelegramに返信します。

注意：

- **ノードはGatewayサービスを実行しません。** 意図的に分離されたプロファイルを実行しない限り、ホストごとに1つのGatewayのみが実行されるべきです（[複数のGateway](/gateway/multiple-gateways)を参照）。
- macOSアプリの「ノードモード」はGateway WebSocket経由のノードクライアントに過ぎません。

## SSHトンネル（CLI + ツール）

リモートGateway WSへのローカルトンネルを作成します：

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

トンネルが稼働中：

- `openclaw health`と`openclaw status --deep`が`ws://127.0.0.1:18789`経由でリモートGatewayに到達します。
- `openclaw gateway {status,health,send,agent,call}`も必要に応じて`--url`で転送URLをターゲットできます。

注意：`18789`を設定された`gateway.port`（または`--port`/`OPENCLAW_GATEWAY_PORT`）に置き換えてください。
注意：`--url`を渡す場合、CLIは設定や環境の認証情報にフォールバックしません。
`--token`または`--password`を明示的に含めてください。明示的な認証情報の欠如はエラーです。

## CLIリモートデフォルト

CLIコマンドがデフォルトで使用するリモートターゲットを永続化できます：

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

Gatewayがループバックのみの場合、URLを`ws://127.0.0.1:18789`のままにして、最初にSSHトンネルを開いてください。

## 認証情報の優先順位

Gatewayの呼び出し/プローブ認証情報の解決は、1つの共有契約に従います：

- 明示的な認証情報（`--token`、`--password`、またはツールの`gatewayToken`）が常に優先されます。
- ローカルモードのデフォルト：
  - トークン：`OPENCLAW_GATEWAY_TOKEN` -> `gateway.auth.token` -> `gateway.remote.token`
  - パスワード：`OPENCLAW_GATEWAY_PASSWORD` -> `gateway.auth.password` -> `gateway.remote.password`
- リモートモードのデフォルト：
  - トークン：`gateway.remote.token` -> `OPENCLAW_GATEWAY_TOKEN` -> `gateway.auth.token`
  - パスワード：`OPENCLAW_GATEWAY_PASSWORD` -> `gateway.remote.password` -> `gateway.auth.password`
- リモートプローブ/ステータスのトークンチェックはデフォルトで厳格です：リモートモードをターゲットにする場合、`gateway.remote.token`のみを使用します（ローカルトークンフォールバックなし）。
- レガシーの`CLAWDBOT_GATEWAY_*`環境変数は互換性の呼び出しパスでのみ使用されます。プローブ/ステータス/認証解決は`OPENCLAW_GATEWAY_*`のみを使用します。

## SSH経由のChat UI

WebChatは別のHTTPポートを使用しなくなりました。SwiftUIチャットUIはGateway WebSocketに直接接続します。

- SSH経由で`18789`を転送し（上記参照）、クライアントを`ws://127.0.0.1:18789`に接続します。
- macOSでは、トンネルを自動管理するアプリの「Remote over SSH」モードを推奨します。

## macOSアプリ「Remote over SSH」

macOSメニューバーアプリは同じセットアップをエンドツーエンドで管理できます（リモートステータスチェック、WebChat、Voice Wakeフォワーディング）。

ランブック：[macOSリモートアクセス](/platforms/mac/remote)。

## セキュリティルール（リモート/VPN）

要約：確実にバインドが必要でない限り、**Gatewayをループバックのみに保ちます**。

- **ループバック + SSH/Tailscale Serve**が最も安全なデフォルトです（パブリック公開なし）。
- **非ループバックバインド**（`lan`/`tailnet`/`custom`、またはループバックが利用不可の場合の`auto`）には認証トークン/パスワードが必要です。
- `gateway.remote.token` / `.password`はクライアント認証情報のソースです。それ自体ではサーバー認証を設定**しません**。
- ローカル呼び出しパスは`gateway.auth.*`が未設定の場合にフォールバックとして`gateway.remote.*`を使用できます。
- `gateway.remote.tlsFingerprint`は`wss://`使用時にリモートTLS証明書をピンします。
- **Tailscale Serve**は`gateway.auth.allowTailscale: true`の場合、アイデンティティヘッダー経由でControl UI/WebSocketトラフィックを認証できます。HTTP APIエンドポイントにはトークン/パスワード認証が必要です。このトークンレスフローはGatewayホストが信頼されていることを前提としています。すべてにトークン/パスワードを要求する場合は`false`に設定してください。
- ブラウザコントロールはオペレーターアクセスと同様に扱います：Tailnetのみ + 意図的なノードペアリング。

詳細：[セキュリティ](/gateway/security)。
