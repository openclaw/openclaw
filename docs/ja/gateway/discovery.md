---
summary: "ゲートウェイを見つけるためのノードディスカバリーとトランスポート（Bonjour、Tailscale、SSH）"
read_when:
  - Bonjour のディスカバリー／アドバタイズを実装または変更する場合
  - リモート接続モード（直接接続 vs SSH）を調整する場合
  - リモートノード向けのノードディスカバリー＋ペアリングを設計する場合
title: "ディスカバリーとトランスポート"
---

# Discovery & transports

OpenClaw には、表面的には似ているものの、異なる 2 つの問題があります。

1. **オペレーターのリモート制御**: 別の場所で稼働しているゲートウェイを制御する macOS メニューバーアプリ。
2. **ノードのペアリング**: iOS／Android（および将来のノード）がゲートウェイを見つけ、安全にペアリングすること。

設計目標は、すべてのネットワークディスカバリー／アドバタイズを **Node Gateway**（`openclaw gateway`）に集約し、クライアント（mac アプリ、iOS）はコンシューマーとして扱うことです。

## Terms

- **Gateway**: 状態（セッション、ペアリング、ノードレジストリ）を所有し、チャンネルを実行する、単一の長時間稼働するゲートウェイプロセス。多くの構成ではホストごとに 1 つを使用しますが、分離されたマルチゲートウェイ構成も可能です。 ほとんどのセットアップはホストごとに1つを使用します。孤立したマルチゲートウェイの設定は可能です。
- **Gateway WS (control plane)**: 既定で `127.0.0.1:18789` にある WebSocket エンドポイント。`gateway.bind` により LAN／tailnet にバインドできます。
- **Direct WS transport**: LAN／tailnet 向けの Gateway WS エンドポイント（SSH なし）。
- **SSH transport (fallback)**: SSH 経由で `127.0.0.1:18789` をフォワードするリモート制御。
- **Legacy TCP bridge (deprecated/removed)**: 旧来のノードトランスポート（[Bridge protocol](/gateway/bridge-protocol) を参照）。ディスカバリーではもはやアドバタイズされません。

プロトコルの詳細:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Why we keep both “direct” and SSH

- **Direct WS** は、同一ネットワークおよび tailnet 内で最良の UX を提供します。
  - Bonjour による LAN 上の自動ディスカバリー
  - ゲートウェイが所有するペアリングトークンと ACL
  - シェルアクセス不要。プロトコルの表面を厳密かつ監査可能に保てます
- **SSH** は汎用的なフォールバックとして残します。
  - SSH アクセスがあればどこでも動作します（無関係なネットワーク間でも可）
  - マルチキャスト／mDNS の問題に耐性があります
  - SSH 以外の新たなインバウンドポートを必要としません

## Discovery inputs（クライアントがゲートウェイの所在を知る方法）

### 1. Bonjour / mDNS（LAN のみ）

Bonjourはベストエフォートであり、ネットワークを横断することはありません。 Bonjour はベストエフォートであり、ネットワークを越えません。「同一 LAN」向けの利便性のためにのみ使用されます。

目標の方向性:

- **ゲートウェイ**が、Bonjour を通じて WS エンドポイントをアドバタイズします。
- クライアントは一覧を表示して「ゲートウェイを選択」し、選択したエンドポイントを保存します。

トラブルシューティングとビーコンの詳細: [Bonjour](/gateway/bonjour)。

#### Service beacon details

- サービスタイプ:
  - `_openclaw-gw._tcp`（ゲートウェイトランスポートのビーコン）
- TXT キー（非シークレット）:
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22`（またはアドバタイズされている任意の値）
  - `gatewayPort=18789`（Gateway WS + HTTP）
  - `gatewayTls=1`（TLS 有効時のみ）
  - `gatewayTlsSha256=<sha256>`（TLS 有効かつフィンガープリントが利用可能な場合のみ）
  - `canvasPort=18793`（既定の canvas ホストポート。`/__openclaw__/canvas/` を提供）
  - `cliPath=<path>`（任意。実行可能な `openclaw` のエントリポイントまたはバイナリへの絶対パス）
  - `tailnetDns=<magicdns>`（任意のヒント。Tailscale が利用可能な場合は自動検出）

無効化／上書き:

- `OPENCLAW_DISABLE_BONJOUR=1` はアドバタイズを無効化します。
- `gateway.bind` を `~/.openclaw/openclaw.json` に設定すると、Gateway のバインドモードを制御します。
- `OPENCLAW_SSH_PORT` は、TXT でアドバタイズされる SSH ポートを上書きします（既定は 22）。
- `OPENCLAW_TAILNET_DNS` は `tailnetDns` のヒント（MagicDNS）を公開します。
- `OPENCLAW_CLI_PATH` は、アドバタイズされる CLI パスを上書きします。

### 2. Tailnet（ネットワーク横断）

ロンドン/ウィーンスタイルの設定では、Bonjour は役に立ちません。 推奨される「ダイレクト」ターゲットは:

- Tailscale MagicDNS 名（推奨）または安定した tailnet IP。

ゲートウェイが Tailscale 配下で実行されていることを検出できる場合、クライアント向けの任意のヒントとして `tailnetDns` を公開します（広域ビーコンを含む）。

### 3. 手動／SSH ターゲット

直接ルートがない場合（または直接接続が無効な場合）、クライアントはループバックのゲートウェイポートをフォワードすることで、常に SSH 経由で接続できます。

[Remote access](/gateway/remote) を参照してください。

## Transport selection（クライアントのポリシー）

推奨されるクライアントの挙動:

1. ペアリング済みの直接エンドポイントが設定され、到達可能であれば、それを使用します。
2. そうでなければ、Bonjour が LAN 上のゲートウェイを検出した場合、「このゲートウェイを使用」のワンタップ選択肢を提示し、直接エンドポイントとして保存します。
3. そうでない場合は、tailnet DNS/IP が設定されている場合は、直接試してみてください。
4. 最後に、SSH にフォールバックします。

## Pairing + auth（直接トランスポート）

ノード／クライアントの受け入れに関する信頼の源泉はゲートウェイです。

- ペアリング要求はゲートウェイで作成／承認／拒否されます（[Gateway pairing](/gateway/pairing) を参照）。
- ゲートウェイは次を強制します。
  - 認証（トークン／鍵ペア）
  - スコープ／ACL（ゲートウェイは、すべてのメソッドへの生のプロキシではありません）
  - レート制限

## Responsibilities by component

- **Gateway**: ディスカバリー用ビーコンをアドバタイズし、ペアリングの意思決定を所有し、WS エンドポイントをホストします。
- **macOS app**: ゲートウェイの選択を支援し、ペアリングのプロンプトを表示し、SSH はフォールバックとしてのみ使用します。
- **iOS／Android nodes**: 利便性のために Bonjour を参照し、ペアリング済みの Gateway WS に接続します。
