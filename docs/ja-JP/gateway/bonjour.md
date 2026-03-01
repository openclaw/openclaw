---
summary: "Bonjour/mDNSディスカバリー + デバッグ（Gatewayビーコン、クライアント、一般的な障害モード）"
read_when:
  - Debugging Bonjour discovery issues on macOS/iOS
  - Changing mDNS service types, TXT records, or discovery UX
title: "Bonjourディスカバリー"
---

# Bonjour / mDNSディスカバリー

OpenClawはBonjour（mDNS / DNS-SD）を**LAN限定の便利機能**として使用し、アクティブなGateway（WebSocketエンドポイント）を検出します。ベストエフォートであり、SSHやTailnetベースの接続を**置き換えるものではありません**。

## Wide-Area Bonjour（Unicast DNS-SD）over Tailscale

ノードとGatewayが異なるネットワークにある場合、マルチキャストmDNSは境界を越えることができません。Tailscale経由で**ユニキャストDNS-SD**（「Wide-Area Bonjour」）に切り替えることで、同じディスカバリーUXを維持できます。

概要手順：

1. Gatewayホストでdnsサーバーを実行します（Tailnet経由で到達可能）。
2. 専用ゾーン（例：`openclaw.internal.`）の下に`_openclaw-gw._tcp`のDNS-SDレコードを公開します。
3. TailscaleのスプリットDNSを設定して、選択したドメインがクライアント（iOSを含む）でそのDNSサーバー経由で解決されるようにします。

OpenClawは任意のディスカバリードメインをサポートします。`openclaw.internal.`は一例です。iOS/Androidノードは`local.`と設定されたWide-Areaドメインの両方をブラウズします。

### Gateway設定（推奨）

```json5
{
  gateway: { bind: "tailnet" }, // tailnet限定（推奨）
  discovery: { wideArea: { enabled: true } }, // Wide-Area DNS-SD公開を有効化
}
```

### ワンタイムDNSサーバーセットアップ（Gatewayホスト）

```bash
openclaw dns setup --apply
```

これによりCoreDNSがインストールされ、以下のように設定されます：

- GatewayのTailscaleインターフェースのみでポート53をリッスン
- 選択したドメイン（例：`openclaw.internal.`）を`~/.openclaw/dns/<domain>.db`から提供

Tailnet接続マシンから検証：

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS設定

Tailscale管理コンソールで：

- GatewayのTailnet IP（UDP/TCP 53）を指すネームサーバーを追加します。
- ディスカバリードメインがそのネームサーバーを使用するようにスプリットDNSを追加します。

クライアントがTailnet DNSを受け入れると、iOSノードはマルチキャストなしでディスカバリードメインの`_openclaw-gw._tcp`をブラウズできます。

### Gatewayリスナーセキュリティ（推奨）

Gateway WSポート（デフォルト`18789`）はデフォルトでループバックにバインドします。LAN/Tailnetアクセスの場合は、明示的にバインドし、認証を有効にしてください。

Tailnet限定セットアップの場合：

- `~/.openclaw/openclaw.json`で`gateway.bind: "tailnet"`を設定します。
- Gatewayを再起動します（またはmacOSメニューバーアプリを再起動します）。

## アドバタイズするもの

Gatewayのみが`_openclaw-gw._tcp`をアドバタイズします。

## サービスタイプ

- `_openclaw-gw._tcp` -- Gatewayトランスポートビーコン（macOS/iOS/Androidノードで使用）。

## TXTキー（非シークレットヒント）

GatewayはUIフローを便利にするための小さな非シークレットヒントをアドバタイズします：

- `role=gateway`
- `displayName=<フレンドリー名>`
- `lanHost=<ホスト名>.local`
- `gatewayPort=<ポート>`（Gateway WS + HTTP）
- `gatewayTls=1`（TLSが有効な場合のみ）
- `gatewayTlsSha256=<sha256>`（TLSが有効でフィンガープリントが利用可能な場合のみ）
- `canvasPort=<ポート>`（Canvasホストが有効な場合のみ。現在は`gatewayPort`と同じ）
- `sshPort=<ポート>`（オーバーライドされない場合はデフォルト22）
- `transport=gateway`
- `cliPath=<パス>`（オプション。実行可能な`openclaw`エントリポイントへの絶対パス）
- `tailnetDns=<magicdns>`（Tailnetが利用可能な場合のオプションヒント）

セキュリティに関する注意：

- Bonjour/mDNS TXTレコードは**認証されていません**。クライアントはTXTを権威あるルーティングとして扱ってはいけません。
- クライアントは解決されたサービスエンドポイント（SRV + A/AAAA）を使用してルーティングすべきです。`lanHost`、`tailnetDns`、`gatewayPort`、`gatewayTlsSha256`はヒントとしてのみ扱ってください。
- TLSピンニングは、アドバタイズされた`gatewayTlsSha256`が以前に保存されたピンを上書きすることを許可してはいけません。
- iOS/Androidノードはディスカバリーベースの直接接続を**TLS限定**として扱い、初めてのフィンガープリントを信頼する前に明示的なユーザー確認を要求すべきです。

## macOSでのデバッグ

便利な組み込みツール：

- インスタンスをブラウズ：

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- 1つのインスタンスを解決（`<instance>`を置き換えてください）：

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

ブラウズは機能するが解決が失敗する場合は、通常LANポリシーまたはmDNSリゾルバーの問題です。

## Gatewayログでのデバッグ

Gatewayはローリングログファイルを書き込みます（起動時に`gateway log file: ...`として表示されます）。`bonjour:`で始まる行を探してください。特に：

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOSノードでのデバッグ

iOSノードは`NWBrowser`を使用して`_openclaw-gw._tcp`を検出します。

ログをキャプチャするには：

- 設定 → Gateway → 詳細 → **Discovery Debug Logs**
- 設定 → Gateway → 詳細 → **Discovery Logs** → 再現 → **コピー**

ログにはブラウザの状態遷移と結果セットの変更が含まれます。

## 一般的な障害モード

- **Bonjourはネットワークを越えません**：TailnetまたはSSHを使用してください。
- **マルチキャストがブロックされている**：一部のWi-FiネットワークではmDNSが無効になっています。
- **スリープ/インターフェースの変動**：macOSが一時的にmDNS結果をドロップすることがあります。再試行してください。
- **ブラウズは機能するが解決が失敗する**：マシン名をシンプルに保ち（絵文字や句読点を避ける）、Gatewayを再起動してください。サービスインスタンス名はホスト名から派生するため、過度に複雑な名前は一部のリゾルバーを混乱させることがあります。

## エスケープされたインスタンス名（`\032`）

Bonjour/DNS-SDはサービスインスタンス名のバイトを10進数`\DDD`シーケンスとしてエスケープすることがよくあります（例：スペースは`\032`になります）。

- これはプロトコルレベルでは正常です。
- UIは表示用にデコードすべきです（iOSは`BonjourEscapes.decode`を使用します）。

## 無効化/設定

- `OPENCLAW_DISABLE_BONJOUR=1`はアドバタイズを無効にします（レガシー：`OPENCLAW_DISABLE_BONJOUR`）。
- `~/.openclaw/openclaw.json`の`gateway.bind`はGatewayバインドモードを制御します。
- `OPENCLAW_SSH_PORT`はTXTでアドバタイズされるSSHポートをオーバーライドします（レガシー：`OPENCLAW_SSH_PORT`）。
- `OPENCLAW_TAILNET_DNS`はTXTでMagicDNSヒントを公開します（レガシー：`OPENCLAW_TAILNET_DNS`）。
- `OPENCLAW_CLI_PATH`はアドバタイズされるCLIパスをオーバーライドします（レガシー：`OPENCLAW_CLI_PATH`）。

## 関連ドキュメント

- ディスカバリーポリシーとトランスポート選択：[ディスカバリー](/gateway/discovery)
- ノードペアリング + 承認：[Gatewayペアリング](/gateway/pairing)
