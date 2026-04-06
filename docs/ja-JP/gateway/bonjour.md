---
read_when:
    - macOS/iOSでのBonjourディスカバリーの問題をデバッグする場合
    - mDNSサービスタイプ、TXTレコード、またはディスカバリーUXを変更する場合
summary: Bonjour/mDNSディスカバリーとデバッグ（Gateway ゲートウェイビーコン、クライアント、よくある障害モード）
title: Bonjourディスカバリー
x-i18n:
    generated_at: "2026-04-02T07:41:11Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: cbde92587f00cc0a2707ed1767f33ed2d6e06f4e96c627516324d2d6bdcdbf07
    source_path: gateway/bonjour.md
    workflow: 15
---

# Bonjour / mDNSディスカバリー

OpenClawは、アクティブなGateway ゲートウェイ（WebSocketエンドポイント）を検出するための**LAN限定の便利機能**としてBonjour（mDNS / DNS‑SD）を使用します。これはベストエフォートであり、SSHやTailnetベースの接続を**置き換えるものではありません**。

## Tailscale経由のワイドエリアBonjour（ユニキャストDNS-SD）

ノードとGateway ゲートウェイが異なるネットワーク上にある場合、マルチキャストmDNSは境界を越えることができません。**ユニキャストDNS‑SD**（「ワイドエリアBonjour」）をTailscale経由で使用することで、同じディスカバリーUXを維持できます。

大まかな手順：

1. Gateway ゲートウェイホストでDNSサーバーを実行します（Tailnet経由でアクセス可能）。
2. 専用ゾーン（例：`openclaw.internal.`）の下に `_openclaw-gw._tcp` のDNS‑SDレコードを公開します。
3. Tailscaleの**スプリットDNS**を設定して、選択したドメインがクライアント（iOSを含む）向けにそのDNSサーバー経由で解決されるようにします。

OpenClawは任意のディスカバリードメインをサポートします。`openclaw.internal.` は一例にすぎません。
iOS/Androidノードは `local.` と設定済みのワイドエリアドメインの両方をブラウズします。

### Gateway ゲートウェイ設定（推奨）

```json5
{
  gateway: { bind: "tailnet" }, // tailnet限定（推奨）
  discovery: { wideArea: { enabled: true } }, // ワイドエリアDNS-SD公開を有効にする
}
```

### ワンタイムDNSサーバーセットアップ（Gateway ゲートウェイホスト）

```bash
openclaw dns setup --apply
```

これによりCoreDNSがインストールされ、以下のように設定されます：

- Gateway ゲートウェイのTailscaleインターフェースでのみポート53をリッスン
- `~/.openclaw/dns/<domain>.db` から選択したドメイン（例：`openclaw.internal.`）を提供

Tailnet接続済みのマシンから検証：

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS設定

Tailscale管理コンソールで：

- Gateway ゲートウェイのTailnet IP（UDP/TCP 53）を指すネームサーバーを追加します。
- ディスカバリードメインがそのネームサーバーを使用するようにスプリットDNSを追加します。

クライアントがTailnet DNSを受け入れると、iOSノードはマルチキャストなしでディスカバリードメイン内の `_openclaw-gw._tcp` をブラウズできます。

### Gateway ゲートウェイリスナーのセキュリティ（推奨）

Gateway ゲートウェイのWSポート（デフォルト `18789`）はデフォルトでloopbackにバインドされます。LAN/Tailnetアクセスの場合は、明示的にバインドし、認証を有効にしておいてください。

Tailnet限定のセットアップの場合：

- `~/.openclaw/openclaw.json` で `gateway.bind: "tailnet"` を設定します。
- Gateway ゲートウェイを再起動します（またはmacOSメニューバーアプリを再起動します）。

## アドバタイズするもの

Gateway ゲートウェイのみが `_openclaw-gw._tcp` をアドバタイズします。

## サービスタイプ

- `_openclaw-gw._tcp` — Gateway ゲートウェイトランスポートビーコン（macOS/iOS/Androidノードが使用）。

## TXTキー（非機密ヒント）

Gateway ゲートウェイは、UIフローを便利にするための小さな非機密ヒントをアドバタイズします：

- `role=gateway`
- `displayName=<フレンドリーネーム>`
- `lanHost=<ホスト名>.local`
- `gatewayPort=<ポート>`（Gateway ゲートウェイ WS + HTTP）
- `gatewayTls=1`（TLSが有効な場合のみ）
- `gatewayTlsSha256=<sha256>`（TLSが有効でフィンガープリントが利用可能な場合のみ）
- `canvasPort=<ポート>`（キャンバスホストが有効な場合のみ。現在は `gatewayPort` と同じ）
- `sshPort=<ポート>`（オーバーライドされない場合はデフォルト22）
- `transport=gateway`
- `cliPath=<パス>`（オプション。実行可能な `openclaw` エントリーポイントへの絶対パス）
- `tailnetDns=<magicdns>`（Tailnetが利用可能な場合のオプションヒント）

セキュリティに関する注意：

- Bonjour/mDNS TXTレコードは**認証されていません**。クライアントはTXTを権威あるルーティング情報として扱ってはいけません。
- クライアントは解決されたサービスエンドポイント（SRV + A/AAAA）を使用してルーティングする必要があります。`lanHost`、`tailnetDns`、`gatewayPort`、`gatewayTlsSha256` はヒントとしてのみ扱ってください。
- TLSピンニングでは、アドバタイズされた `gatewayTlsSha256` が以前に保存されたピンを上書きすることを許可してはいけません。
- iOS/Androidノードは、ディスカバリーベースの直接接続を**TLS限定**として扱い、初回のフィンガープリントを信頼する前に明示的なユーザー確認を要求する必要があります。

## macOSでのデバッグ

便利な組み込みツール：

- インスタンスのブラウズ：

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- インスタンスの解決（`<instance>` を置き換えてください）：

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

ブラウズは成功するが解決に失敗する場合は、通常LANポリシーまたはmDNSリゾルバーの問題が原因です。

## Gateway ゲートウェイログでのデバッグ

Gateway ゲートウェイはローリングログファイルを書き込みます（起動時に `gateway log file: ...` として表示されます）。`bonjour:` 行を確認してください。特に：

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOSノードでのデバッグ

iOSノードは `NWBrowser` を使用して `_openclaw-gw._tcp` を検出します。

ログをキャプチャするには：

- 設定 → Gateway ゲートウェイ → 詳細 → **ディスカバリーデバッグログ**
- 設定 → Gateway ゲートウェイ → 詳細 → **ディスカバリーログ** → 再現 → **コピー**

ログにはブラウザの状態遷移と結果セットの変更が含まれます。

## よくある障害モード

- **Bonjourはネットワークを越えられない**: TailnetまたはSSHを使用してください。
- **マルチキャストがブロックされている**: 一部のWi‑FiネットワークではmDNSが無効になっています。
- **スリープ / インターフェースの変動**: macOSが一時的にmDNSの結果をドロップすることがあります。リトライしてください。
- **ブラウズは成功するが解決に失敗する**: マシン名をシンプルに保ち（絵文字や句読点を避ける）、Gateway ゲートウェイを再起動してください。サービスインスタンス名はホスト名から派生するため、過度に複雑な名前は一部のリゾルバーを混乱させる可能性があります。

## エスケープされたインスタンス名（`\032`）

Bonjour/DNS‑SDは、サービスインスタンス名のバイトを10進数の `\DDD` シーケンスとしてエスケープすることがよくあります（例：スペースは `\032` になります）。

- これはプロトコルレベルでは正常です。
- UIは表示用にデコードする必要があります（iOSは `BonjourEscapes.decode` を使用します）。

## 無効化 / 設定

- `OPENCLAW_DISABLE_BONJOUR=1` はアドバタイズを無効にします（レガシー: `OPENCLAW_DISABLE_BONJOUR`）。
- `~/.openclaw/openclaw.json` の `gateway.bind` はGateway ゲートウェイのバインドモードを制御します。
- `OPENCLAW_SSH_PORT` はTXTでアドバタイズされるSSHポートをオーバーライドします（レガシー: `OPENCLAW_SSH_PORT`）。
- `OPENCLAW_TAILNET_DNS` はTXTにMagicDNSヒントを公開します（レガシー: `OPENCLAW_TAILNET_DNS`）。
- `OPENCLAW_CLI_PATH` はアドバタイズされるCLIパスをオーバーライドします（レガシー: `OPENCLAW_CLI_PATH`）。

## 関連ドキュメント

- ディスカバリーポリシーとトランスポート選択: [ディスカバリー](/gateway/discovery)
- ノードペアリングと承認: [Gateway ゲートウェイペアリング](/gateway/pairing)
