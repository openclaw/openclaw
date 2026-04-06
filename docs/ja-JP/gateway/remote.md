---
summary: "SSH トンネル（Gateway ゲートウェイ WS）とテイルネットを使用したリモートアクセス"
read_when:
  - リモート Gateway ゲートウェイのセットアップの実行またはトラブルシューティング時
title: "Remote Access"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 8352f76ffb3d57f2d6c1e34e08625c93e449c22162a2d73a832db6a52e073618
    source_path: gateway/remote.md
    workflow: 15
---

# リモートアクセス（SSH、トンネル、テイルネット）

このリポジトリは「SSH 経由のリモート」をサポートしており、専用ホスト（デスクトップ/サーバー）で単一の Gateway ゲートウェイ（マスター）を実行し、クライアントをそれに接続します。

- **オペレーター（あなた/macOS アプリ）の場合**: SSH トンネリングがユニバーサルフォールバックです。
- **ノード（iOS/Android および将来のデバイス）の場合**: Gateway ゲートウェイの **WebSocket**（LAN/テイルネットまたは必要に応じて SSH トンネル）に接続します。

## 基本的な考え方

- Gateway ゲートウェイ WebSocket は設定されたポート（デフォルト 18789）の**ループバック**にバインドします。
- リモート使用のため、SSH 経由でそのループバックポートを転送します（またはテイルネット/VPN を使用してトンネルを少なくします）。

## よくある VPN/テイルネットのセットアップ（エージェントが存在する場所）

**Gateway ゲートウェイホスト**を「エージェントが存在する場所」と考えてください。セッション、認証プロファイル、チャンネル、ステートを所有します。
ラップトップ/デスクトップ（およびノード）はそのホストに接続します。

### 1) テイルネット内の常時オン Gateway ゲートウェイ（VPS またはホームサーバー）

永続的なホスト上で Gateway ゲートウェイを実行し、**Tailscale** または SSH 経由でアクセスします。

- **最良の UX:** `gateway.bind: "loopback"` を維持し、Control UI に **Tailscale Serve** を使用します。
- **フォールバック:** アクセスが必要などのマシンからも、ループバック + SSH トンネルを維持します。
- **例:** [exe.dev](/install/exe-dev)（簡単な VM）または [Hetzner](/install/hetzner)（本番 VPS）。

これはラップトップがよく眠るがエージェントを常時オンにしたい場合に理想的です。

### 2) ホームデスクトップで Gateway ゲートウェイを実行し、ラップトップがリモートコントロール

ラップトップはエージェントを**実行しません**。リモートで接続します：

- macOS アプリの **Remote over SSH** モードを使用します（設定 → 一般 → 「OpenClaw が実行される場所」）。
- アプリがトンネルを開いて管理するため、WebChat とヘルスチェックが「そのまま動作」します。

ランブック: [macOS リモートアクセス](/platforms/mac/remote)。

### 3) ラップトップで Gateway ゲートウェイを実行し、他のマシンからリモートアクセス

Gateway ゲートウェイをローカルに保持しますが、安全に公開します：

- 他のマシンからラップトップへの SSH トンネル、または
- Tailscale Serve で Control UI を提供し、Gateway ゲートウェイをループバックのみに保つ。

ガイド: [Tailscale](/gateway/tailscale) および [Web 概要](/web)。

## コマンドフロー（何がどこで実行されるか）

1つの Gateway ゲートウェイサービスがステートとチャンネルを所有します。ノードは周辺機器です。

フローの例（Telegram → ノード）：

- Telegram メッセージが **Gateway ゲートウェイ**に届きます。
- Gateway ゲートウェイが**エージェント**を実行し、ノードツールを呼び出すかどうかを決定します。
- Gateway ゲートウェイが Gateway ゲートウェイ WebSocket 経由で**ノード**を呼び出します（`node.*` RPC）。
- ノードが結果を返し、Gateway ゲートウェイが Telegram に返信します。

注意事項：

- **ノードは Gateway ゲートウェイサービスを実行しません。** 意図的に独立したプロファイルを実行する場合を除き、ホストごとに1つの Gateway ゲートウェイのみが実行されるべきです（[複数 Gateway ゲートウェイ](/gateway/multiple-gateways) を参照）。
- macOS アプリの「ノードモード」は Gateway ゲートウェイ WebSocket 経由のノードクライアントに過ぎません。

## SSH トンネル（CLI とツール）

リモート Gateway ゲートウェイ WS へのローカルトンネルを作成します：

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

トンネルが開いている状態で：

- `openclaw health` と `openclaw status --deep` は `ws://127.0.0.1:18789` 経由でリモート Gateway ゲートウェイに到達できます。
- `openclaw gateway {status,health,send,agent,call}` も必要に応じて `--url` 経由で転送された URL をターゲットにできます。

注意: `18789` を設定済みの `gateway.port`（または `--port`/`OPENCLAW_GATEWAY_PORT`）に置き換えてください。
注意: `--url` を渡すと、CLI は設定や環境の認証情報にフォールバックしません。
`--token` または `--password` を明示的に含めてください。明示的な認証情報の欠如はエラーです。

## CLI リモートのデフォルト

リモートターゲットを永続化して CLI コマンドがデフォルトでそれを使用するようにできます：

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

Gateway ゲートウェイがループバックのみの場合、URL を `ws://127.0.0.1:18789` に保ち、先に SSH トンネルを開いてください。

## 認証情報の優先順位

Gateway ゲートウェイの認証情報解決は、call/probe/status パスと Discord の exec-approval モニタリング全体で1つの共有コントラクトに従います。ノードホストは1つのローカルモードの例外（意図的に `gateway.remote.*` を無視）を持つ同じ基本コントラクトを使用します：

- 明示的な認証情報（`--token`、`--password`、またはツールの `gatewayToken`）は、明示的な認証を受け入れる呼び出しパスで常に優先します。
- URL オーバーライドの安全性：
  - CLI の URL オーバーライド（`--url`）は暗黙の設定/環境の認証情報を再使用しません。
  - 環境の URL オーバーライド（`OPENCLAW_GATEWAY_URL`）は環境の認証情報のみを使用できます（`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`）。
- ローカルモードのデフォルト：
  - トークン: `OPENCLAW_GATEWAY_TOKEN` -> `gateway.auth.token` -> `gateway.remote.token`（リモートフォールバックはローカル認証トークン入力が未設定の場合のみ適用）
  - パスワード: `OPENCLAW_GATEWAY_PASSWORD` -> `gateway.auth.password` -> `gateway.remote.password`（リモートフォールバックはローカル認証パスワード入力が未設定の場合のみ適用）
- リモートモードのデフォルト：
  - トークン: `gateway.remote.token` -> `OPENCLAW_GATEWAY_TOKEN` -> `gateway.auth.token`
  - パスワード: `OPENCLAW_GATEWAY_PASSWORD` -> `gateway.remote.password` -> `gateway.auth.password`
- ノードホストのローカルモード例外: `gateway.remote.token` / `gateway.remote.password` は無視されます。
- リモートの probe/status トークンチェックはデフォルトで厳格: リモートモードをターゲットにする場合、`gateway.remote.token` のみを使用します（ローカルトークンフォールバックなし）。
- Gateway ゲートウェイ環境オーバーライドは `OPENCLAW_GATEWAY_*` のみを使用します。

## SSH 経由の Chat UI

WebChat は独立した HTTP ポートを使用しなくなりました。SwiftUI の Chat UI は直接 Gateway ゲートウェイ WebSocket に接続します。

- SSH 経由で `18789` を転送し（上記参照）、クライアントを `ws://127.0.0.1:18789` に接続します。
- macOS では、トンネルを自動的に管理するアプリの「Remote over SSH」モードを優先してください。

## macOS アプリの「Remote over SSH」

macOS メニューバーアプリは同じセットアップをエンドツーエンドで操作できます（リモートステータスチェック、WebChat、Voice Wake 転送）。

ランブック: [macOS リモートアクセス](/platforms/mac/remote)。

## セキュリティルール（リモート/VPN）

簡潔に言えば: 確実に必要でない限り、**Gateway ゲートウェイをループバックのみに保ってください**。

- **ループバック + SSH/Tailscale Serve** が最も安全なデフォルトです（公開露出なし）。
- プレーンテキスト `ws://` はデフォルトでループバックのみです。信頼できるプライベートネットワークでは、クライアントプロセスで `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` をブレークグラスとして設定してください。
- **非ループバックバインド**（`lan`/`tailnet`/`custom`、またはループバックが利用できない場合の `auto`）は認証トークン/パスワードを必要とします。
- `gateway.remote.token` / `.password` はクライアントの認証情報ソースです。それ自体でサーバー認証を設定する**わけではありません**。
- ローカル呼び出しパスは `gateway.auth.*` が未設定の場合のみ `gateway.remote.*` をフォールバックとして使用できます。
- `gateway.auth.token` / `gateway.auth.password` が SecretRef 経由で明示的に設定され未解決の場合、解決はクローズドフェイルします（リモートフォールバックマスキングなし）。
- `gateway.remote.tlsFingerprint` は `wss://` を使用する際にリモート TLS 証明書をピンします。
- **Tailscale Serve** は `gateway.auth.allowTailscale: true` の場合に ID ヘッダー経由で Control UI/WebSocket トラフィックを認証できます; HTTP API エンドポイントは引き続きトークン/パスワード認証を必要とします。このトークンレスフローは Gateway ゲートウェイホストが信頼されていることを前提とします。トークン/パスワードをすべての場所で必要とする場合は `false` に設定してください。
- ブラウザーコントロールをオペレーターアクセスと同様に扱います: テイルネットのみ + 意図的なノードペアリング。

詳細: [セキュリティ](/gateway/security)。

### macOS: LaunchAgent 経由の永続 SSH トンネル

リモート Gateway ゲートウェイに接続する macOS クライアントの場合、最も簡単な永続的なセットアップは、SSH `LocalForward` 設定エントリに LaunchAgent を組み合わせて、再起動やクラッシュをまたいでトンネルを生かし続けることです。

#### ステップ 1: SSH 設定を追加する

`~/.ssh/config` を編集します：

```ssh
Host remote-gateway
    HostName <REMOTE_IP>
    User <REMOTE_USER>
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

`<REMOTE_IP>` と `<REMOTE_USER>` をご自分の値に置き換えてください。

#### ステップ 2: SSH キーをコピーする（1回のみ）

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

#### ステップ 3: Gateway ゲートウェイトークンを設定する

再起動をまたいでトークンが永続するよう設定に保存します：

```bash
openclaw config set gateway.remote.token "<your-token>"
```

#### ステップ 4: LaunchAgent を作成する

`~/Library/LaunchAgents/ai.openclaw.ssh-tunnel.plist` として保存します：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

#### ステップ 5: LaunchAgent をロードする

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.ssh-tunnel.plist
```

トンネルはログイン時に自動的に起動し、クラッシュ時に再起動し、転送されたポートを生かし続けます。

注意: 古いセットアップからの `com.openclaw.ssh-tunnel` LaunchAgent が残っている場合は、アンロードして削除してください。

#### トラブルシューティング

トンネルが実行中か確認：

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

トンネルを再起動：

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.ssh-tunnel
```

トンネルを停止：

```bash
launchctl bootout gui/$UID/ai.openclaw.ssh-tunnel
```

| 設定エントリ                         | 機能                                                         |
| ------------------------------------ | ------------------------------------------------------------ |
| `LocalForward 18789 127.0.0.1:18789` | ローカルポート 18789 をリモートポート 18789 に転送           |
| `ssh -N`                             | リモートコマンドを実行しない SSH（ポート転送のみ）           |
| `KeepAlive`                          | クラッシュ時にトンネルを自動再起動                           |
| `RunAtLoad`                          | ログイン時に LaunchAgent がロードされたときにトンネルを起動  |
