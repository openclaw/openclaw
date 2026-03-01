---
summary: "ノードディスカバリーとトランスポート（Bonjour、Tailscale、SSH）によるGatewayの検出"
read_when:
  - Implementing or changing Bonjour discovery/advertising
  - Adjusting remote connection modes (direct vs SSH)
  - Designing node discovery + pairing for remote nodes
title: "ディスカバリーとトランスポート"
---

# ディスカバリーとトランスポート

OpenClawには、表面上は似ているが異なる2つの問題があります：

1. **オペレーターリモートコントロール**：macOSメニューバーアプリが別の場所で実行されているGatewayを制御すること。
2. **ノードペアリング**：iOS/Android（および将来のノード）がGatewayを見つけ、安全にペアリングすること。

設計目標は、すべてのネットワークディスカバリー/アドバタイジングを**Node Gateway**（`openclaw gateway`）に保ち、クライアント（macアプリ、iOS）はコンシューマーとして動作させることです。

## 用語

- **Gateway**：状態（セッション、ペアリング、ノードレジストリ）を所有し、チャンネルを実行する単一の長時間実行Gatewayプロセス。ほとんどのセットアップはホストごとに1つ使用します。分離されたマルチGatewayセットアップも可能です。
- **Gateway WS（コントロールプレーン）**：デフォルトで`127.0.0.1:18789`のWebSocketエンドポイント。`gateway.bind`経由でLAN/Tailnetにバインドできます。
- **直接WSトランスポート**：LAN/Tailnet向けのGateway WSエンドポイント（SSHなし）。
- **SSHトランスポート（フォールバック）**：`127.0.0.1:18789`をSSH経由でフォワードするリモートコントロール。
- **レガシーTCPブリッジ（非推奨/削除済み）**：古いノードトランスポート（[Bridgeプロトコル](/gateway/bridge-protocol)を参照）。ディスカバリーではアドバタイズされなくなりました。

プロトコルの詳細：

- [Gatewayプロトコル](/gateway/protocol)
- [Bridgeプロトコル（レガシー）](/gateway/bridge-protocol)

## 「直接」とSSHの両方を維持する理由

- **直接WS**は同じネットワークおよびTailnet内で最高のUXを提供します：
  - LAN上のBonjourによる自動検出
  - Gatewayが所有するペアリングトークン + ACL
  - シェルアクセス不要。プロトコルサーフェスをタイトで監査可能に保てます
- **SSH**は汎用的なフォールバックとして残ります：
  - SSHアクセスがあればどこでも動作します（無関係なネットワーク間でも）
  - マルチキャスト/mDNSの問題を回避
  - SSH以外に新しい受信ポートが不要

## ディスカバリー入力（クライアントがGatewayの場所を学ぶ方法）

### 1) Bonjour / mDNS（LAN限定）

Bonjourはベストエフォートであり、ネットワークを越えません。「同じLAN」の便利さのためにのみ使用されます。

目標方向：

- **Gateway**がBonjour経由でWSエンドポイントをアドバタイズします。
- クライアントがブラウズして「Gatewayを選択」リストを表示し、選択したエンドポイントを保存します。

トラブルシューティングとビーコンの詳細：[Bonjour](/gateway/bonjour)。

#### サービスビーコンの詳細

- サービスタイプ：
  - `_openclaw-gw._tcp`（Gatewayトランスポートビーコン）
- TXTキー（非シークレット）：
  - `role=gateway`
  - `lanHost=<ホスト名>.local`
  - `sshPort=22`（またはアドバタイズされた値）
  - `gatewayPort=18789`（Gateway WS + HTTP）
  - `gatewayTls=1`（TLSが有効な場合のみ）
  - `gatewayTlsSha256=<sha256>`（TLSが有効でフィンガープリントが利用可能な場合のみ）
  - `canvasPort=<ポート>`（Canvasホストポート。Canvasホストが有効な場合、現在`gatewayPort`と同じ）
  - `cliPath=<パス>`（オプション。実行可能な`openclaw`エントリポイントまたはバイナリへの絶対パス）
  - `tailnetDns=<magicdns>`（オプションヒント。Tailscaleが利用可能な場合に自動検出）

セキュリティに関する注意：

- Bonjour/mDNS TXTレコードは**認証されていません**。クライアントはTXT値をUXヒントとしてのみ扱うべきです。
- ルーティング（ホスト/ポート）はTXT提供の`lanHost`、`tailnetDns`、`gatewayPort`よりも**解決されたサービスエンドポイント**（SRV + A/AAAA）を優先すべきです。
- TLSピンニングは、アドバタイズされた`gatewayTlsSha256`が以前に保存されたピンを上書きすることを許可してはいけません。
- iOS/Androidノードはディスカバリーベースの直接接続を**TLS限定**として扱い、初めてのピンを保存する前に明示的な「このフィンガープリントを信頼する」確認を要求すべきです（アウトオブバンド検証）。

無効化/オーバーライド：

- `OPENCLAW_DISABLE_BONJOUR=1`はアドバタイジングを無効にします。
- `~/.openclaw/openclaw.json`の`gateway.bind`はGatewayバインドモードを制御します。
- `OPENCLAW_SSH_PORT`はTXTでアドバタイズされるSSHポートをオーバーライドします（デフォルト22）。
- `OPENCLAW_TAILNET_DNS`は`tailnetDns`ヒント（MagicDNS）を公開します。
- `OPENCLAW_CLI_PATH`はアドバタイズされるCLIパスをオーバーライドします。

### 2) Tailnet（クロスネットワーク）

ロンドン/ウィーンスタイルのセットアップでは、Bonjourは役に立ちません。推奨される「直接」ターゲットは：

- Tailscale MagicDNS名（推奨）または安定したTailnet IP。

GatewayがTailscaleの下で実行されていることを検出できる場合、クライアント向け（Wide-Areaビーコンを含む）のオプションヒントとして`tailnetDns`を公開します。

### 3) 手動 / SSHターゲット

直接ルートがない場合（または直接が無効な場合）、クライアントはループバックGatewayポートをフォワードすることで常にSSH経由で接続できます。

[リモートアクセス](/gateway/remote)を参照してください。

## トランスポート選択（クライアントポリシー）

推奨されるクライアント動作：

1. ペアリングされた直接エンドポイントが設定されていて到達可能な場合、それを使用します。
2. そうでない場合、BonjourがLAN上でGatewayを見つけた場合、ワンタップの「このGatewayを使用」選択肢を提供し、直接エンドポイントとして保存します。
3. そうでない場合、Tailnet DNS/IPが設定されている場合、直接を試みます。
4. そうでない場合、SSHにフォールバックします。

## ペアリング + 認証（直接トランスポート）

Gatewayはノード/クライアントアドミッションの真実の情報源です。

- ペアリングリクエストはGatewayで作成/承認/拒否されます（[Gatewayペアリング](/gateway/pairing)を参照）。
- Gatewayは以下を強制します：
  - 認証（トークン / キーペア）
  - スコープ/ACL（Gatewayはすべてのメソッドへの生のプロキシではありません）
  - レート制限

## コンポーネントごとの責任

- **Gateway**：ディスカバリービーコンをアドバタイズし、ペアリング決定を所有し、WSエンドポイントをホストします。
- **macOSアプリ**：Gatewayの選択を支援し、ペアリングプロンプトを表示し、フォールバックとしてのみSSHを使用します。
- **iOS/Androidノード**：便利な機能としてBonjourをブラウズし、ペアリングされたGateway WSに接続します。
