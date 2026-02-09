---
summary: "SSH トンネル（Gateway WS）およびテイルネットを使用したリモートアクセス"
read_when:
  - リモート ゲートウェイ 構成の実行またはトラブルシューティング時
title: "リモートアクセス"
---

# リモートアクセス（SSH、トンネル、テイルネット）

このリポジトリは、専用ホスト（デスクトップ／サーバー）上で単一の Gateway（マスター）を稼働させ、クライアントがそれに接続することで「SSH 経由のリモート接続」をサポートします。

- **オペレーター（あなた／macOS アプリ）向け**: SSH トンネリングが汎用的なフォールバックです。
- **ノード（iOS/Android および将来のデバイス）向け**: Gateway **WebSocket** に接続します（LAN／テイルネット、または必要に応じて SSH トンネル）。

## 基本的な考え方

- Gateway WebSocket は、設定されたポート（デフォルトは 18789）で **loopback** にバインドされます。
- リモート利用では、その loopback ポートを SSH 経由でフォワードします（またはテイルネット／VPN を使用してトンネルを最小化します）。

## 一般的な VPN／テイルネット 構成（エージェントの配置先）

**ゲートウェイホスト**を「エージェントが住んでいる場所」と考えてください。 セッション、認証プロファイル、チャンネル、状態を所有しています。
ノートパソコン/デスクトップ (およびノード) がそのホストに接続します。

### 1. テイルネット内の常時稼働 Gateway（VPS または自宅サーバー）

永続的なホストで Gateway を実行し、**Tailscale** または SSH で到達します。

- **最良の UX**: `gateway.bind: "loopback"` を維持し、Control UI には **Tailscale Serve** を使用します。
- **フォールバック**: loopback を維持し、アクセスが必要な任意のマシンから SSH トンネルを張ります。
- **例**: [exe.dev](/install/exe-dev)（簡単な VM）または [Hetzner](/install/hetzner)（本番用 VPS）。

ノート PC が頻繁にスリープするが、エージェントは常時稼働させたい場合に最適です。

### 2. 自宅デスクトップで Gateway を実行し、ノート PC はリモート操作

ノート PC ではエージェントを **実行しません**。リモートで接続します。 リモート接続:

- macOS アプリの **Remote over SSH** モードを使用します（設定 → 一般 → 「OpenClaw runs」）。
- アプリがトンネルを開いて管理するため、WebChat とヘルスチェックが「そのまま」動作します。

運用手順: [macOS remote access](/platforms/mac/remote)。

### 3. ノート PC で Gateway を実行し、他のマシンからリモートアクセス

Gateway をローカルに保ちつつ、安全に公開します。

- 他のマシンからノート PC へ SSH トンネルを張る、または
- Control UI を Tailscale Serve で提供し、Gateway は loopback のみに保ちます。

ガイド: [Tailscale](/gateway/tailscale) および [Web overview](/web)。

## コマンドフロー（どこで何が動くか）

1 つのゲートウェイサービスは state + channels を所有します。 ノードは周辺機器です。

フロー例（Telegram → ノード）:

- Telegram メッセージが **Gateway** に到着します。
- Gateway が **エージェント** を実行し、ノード ツールを呼び出すかどうかを判断します。
- Gateway が Gateway WebSocket（`node.*` RPC）経由で **ノード** を呼び出します。
- ノードが結果を返し、Gateway が Telegram に返信します。

注記:

- **ノードは Gateway サービスを実行しません。** 意図的に分離したプロファイルを実行しない限り、1 ホストにつき 1 つの Gateway のみを実行してください（[Multiple gateways](/gateway/multiple-gateways) を参照）。
- macOS アプリの「ノード モード」は、Gateway WebSocket 経由の単なるノード クライアントです。

## SSH トンネル（CLI + ツール）

リモート Gateway WS へのローカル トンネルを作成します。

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

トンネルが有効な状態では:

- `openclaw health` と `openclaw status --deep` は、`ws://127.0.0.1:18789` 経由でリモート ゲートウェイ に到達します。
- `openclaw gateway {status,health,send,agent,call}` も、必要に応じて `--url` を介してフォワードされた URL を対象にできます。

注意: 設定された `gateway.port` (または `--port`/`OPENCLAW_GATEWAY_PORT`) に `18789` を置き換えます。
注意: `--url`を渡すと、CLIは設定や環境の資格情報には戻りません。
明示的に `--token` または `--password` を含めます。 明示的な資格情報が見つかりませんでした。

## CLI のリモート既定値

CLI コマンドが既定で使用するリモート ターゲットを永続化できます。

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

ゲートウェイ が loopback のみの場合、URL は `ws://127.0.0.1:18789` のままにし、先に SSH トンネルを開いてください。

## SSH 経由の Chat UI

WebChat は個別の HTTP ポートを使用しなくなりました。 WebChat は、もはや別個の HTTP ポートを使用しません。SwiftUI のチャット UI は Gateway WebSocket に直接接続します。

- `18789` を SSH 経由でフォワードし（上記参照）、クライアントを `ws://127.0.0.1:18789` に接続します。
- macOS では、トンネルを自動管理するアプリの「Remote over SSH」モードを優先してください。

## macOS アプリの「Remote over SSH」

macOS のメニューバー アプリは、同一の構成をエンドツーエンドで操作できます（リモート ステータス チェック、WebChat、音声ウェイクのフォワーディング）。

運用手順: [macOS remote access](/platforms/mac/remote)。

## セキュリティ ルール（リモート／VPN）

短いバージョン: **ゲートウェイのループバックのみ**を保持します。バインドが必要だと確信していない限り。

- **Loopback + SSH／Tailscale Serve** が最も安全な既定値です（公開露出なし）。
- **非 loopback バインド**（`lan`/`tailnet`/`custom`、または loopback が利用できない場合の `auto`）では、認証トークン／パスワードを必ず使用してください。
- `gateway.remote.token` は、リモート CLI 呼び出し **専用** です。ローカル認証を有効化 **しません**。
- `gateway.remote.tlsFingerprint` は、`wss://` 使用時にリモート TLS 証明書をピン留めします。
- **Tailscale Serve** は、`gateway.auth.allowTailscale: true` の場合に ID ヘッダーで認証できます。  
  トークン／パスワードを使用したい場合は `false` に設定してください。
  代わりにトークン/パスワードが必要な場合は `false` に設定します。
- ブラウザによる操作はオペレーター アクセスとして扱ってください。テイルネット 限定 + 意図的なノード ペアリングを行います。

詳細解説: [Security](/gateway/security)。
