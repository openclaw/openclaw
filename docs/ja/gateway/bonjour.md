---
summary: "Bonjour/mDNS による検出とデバッグ（Gateway ビーコン、クライアント、一般的な失敗モード）"
read_when:
  - macOS/iOS での Bonjour 検出問題をデバッグする場合
  - mDNS サービスタイプ、TXT レコード、検出 UX を変更する場合
title: "Bonjour 検出"
---

# Bonjour / mDNS 検出

OpenClaw は、アクティブな Gateway（WebSocket エンドポイント）を検出するために、**LAN 限定の利便性機能**として Bonjour（mDNS / DNS‑SD）を使用します。これはベストエフォートであり、SSH や
Tailnet ベースの接続を**置き換えるものではありません**。 これはベストエフォートであり、SSHまたは
Tailnetベースの接続を**置き換えません**。

## Tailscale 経由のワイドエリア Bonjour（ユニキャスト DNS‑SD）

ノードとゲートウェイが異なるネットワーク上にある場合、マルチキャスト mDNS は境界を越えません。同じ検出 UX を維持するには、Tailscale 経由で **ユニキャスト DNS‑SD**
（「ワイドエリア Bonjour」）に切り替えます。 同じ発見を維持するには、Tailscale上で**ユニキャストDNS‐SD**
("Wide‐Area Bonjour")に切り替えます。

高レベルの手順:

1. ゲートウェイ ホスト上で DNS サーバーを実行します（Tailnet 経由で到達可能）。
2. 専用ゾーン配下に `_openclaw-gw._tcp` 向けの DNS‑SD レコードを公開します
   （例: `openclaw.internal.`）。
3. Tailscale の **スプリット DNS** を設定し、選択したドメインがその DNS サーバーで解決されるようにします
   （iOS を含むクライアント）。

OpenClaw は任意の検出ドメインをサポートします。`openclaw.internal.` は単なる例です。
iOS/Android ノードは `local.` と、設定したワイドエリア ドメインの両方をブラウズします。
iOS/Androidノードは、`local.`と設定された広域ドメインの両方を参照します。

### Gateway 設定（推奨）

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### DNS サーバーの一度きりのセットアップ（Gateway ホスト）

```bash
openclaw dns setup --apply
```

これにより CoreDNS がインストールされ、次のように設定されます:

- ゲートウェイの Tailscale インターフェース上でのみ、ポート 53 で待ち受け
- 選択したドメイン（例: `openclaw.internal.`）を `~/.openclaw/dns/<domain>.db` から提供

Tailnet に接続されたマシンから検証します:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS 設定

Tailscale 管理コンソールで次を行います:

- ゲートウェイの Tailnet IP（UDP/TCP 53）を指すネームサーバーを追加します。
- 検出ドメインがそのネームサーバーを使用するように、スプリット DNS を追加します。

クライアントが Tailnet DNS を受け入れると、iOS ノードはマルチキャストなしで
検出ドメイン内の `_openclaw-gw._tcp` をブラウズできます。

### Gateway リスナーのセキュリティ（推奨）

Gateway の WS ポート（デフォルト `18789`）は、既定では loopback にバインドされます。LAN/Tailnet
アクセスの場合は、明示的にバインドし、認証を有効にしたままにしてください。 LAN/tailnet
アクセスの場合は、明示的にバインドして認証を有効にしておきます。

Tailnet 専用のセットアップの場合:

- `~/.openclaw/openclaw.json` 内で `gateway.bind: "tailnet"` を設定します。
- Gateway を再起動します（または macOS のメニューバー アプリを再起動します）。

## 広告されるもの

`_openclaw-gw._tcp` を広告するのは Gateway のみです。

## サービスタイプ

- `_openclaw-gw._tcp` — ゲートウェイ転送ビーコン（macOS/iOS/Android ノードで使用）。

## TXT キー（非機密のヒント）

Gateway は、UI フローを便利にするための小さな非機密ヒントを広告します:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>`（Gateway WS + HTTP）
- `gatewayTls=1`（TLS が有効な場合のみ）
- `gatewayTlsSha256=<sha256>`（TLS が有効で、フィンガープリントが利用可能な場合のみ）
- `canvasPort=<port>`（キャンバス ホストが有効な場合のみ。デフォルト `18793`）
- `sshPort=<port>`（上書きされていない場合のデフォルトは 22）
- `transport=gateway`
- `cliPath=<path>`（任意。実行可能な `openclaw` エントリポイントへの絶対パス）
- `tailnetDns=<magicdns>`（Tailnet が利用可能な場合の任意のヒント）

## macOS でのデバッグ

役立つ組み込みツール:

- インスタンスをブラウズ:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- 1 つのインスタンスを解決（`<instance>` を置き換え）:

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

ブラウズは動作するが解決に失敗する場合、通常は LAN ポリシーまたは
mDNS リゾルバーの問題です。

## Gateway ログでのデバッグ

Gateway はローテーションされるログファイルを書き込みます（起動時に
`gateway log file: ...` として出力されます）。特に次の
`bonjour:` 行を確認してください: `bonjour:`線を探してください。特に：

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOS ノードでのデバッグ

iOS ノードは `NWBrowser` を使用して `_openclaw-gw._tcp` を検出します。

ログを取得するには:

- 設定 → Gateway → 詳細 → **検出デバッグログ**
- 設定 → Gateway → 詳細 → **検出ログ** → 再現 → **コピー**

ログには、ブラウザーの状態遷移と結果セットの変更が含まれます。

## 一般的な失敗モード

- **Bonjour はネットワークを越えない**: Tailnet または SSH を使用してください。
- **マルチキャストがブロックされている**: 一部の Wi‑Fi ネットワークでは mDNS が無効化されています。
- **スリープ / インターフェースの変動**: macOS は一時的に mDNS の結果を失うことがあります。再試行してください。
- **ブラウズは成功するが解決に失敗する**: マシン名はシンプルに保ってください（絵文字や
  句読点を避けます）。その後 Gateway を再起動します。サービス インスタンス名は
  ホスト名から派生するため、過度に複雑な名前は一部のリゾルバーを混乱させる可能性があります。 サービスインスタンス名はホスト名の
  に由来するため、過度に複雑な名前はリゾルバを混乱させる可能性があります。

## エスケープされたインスタンス名（`\032`）

Bonjour/DNS‑SD では、サービス インスタンス名のバイトが 10 進数の `\DDD`
シーケンスとしてエスケープされることがよくあります（例: スペースは `\032`）。

- これはプロトコル レベルでは正常です。
- UI では表示用にデコードする必要があります（iOS は `BonjourEscapes.decode` を使用します）。

## 無効化 / 設定

- `OPENCLAW_DISABLE_BONJOUR=1` は広告を無効化します（レガシー: `OPENCLAW_DISABLE_BONJOUR`）。
- `~/.openclaw/openclaw.json` 内の `gateway.bind` は Gateway のバインド モードを制御します。
- `OPENCLAW_SSH_PORT` は TXT で広告される SSH ポートを上書きします（レガシー: `OPENCLAW_SSH_PORT`）。
- `OPENCLAW_TAILNET_DNS` は TXT に MagicDNS のヒントを公開します（レガシー: `OPENCLAW_TAILNET_DNS`）。
- `OPENCLAW_CLI_PATH` は広告される CLI パスを上書きします（レガシー: `OPENCLAW_CLI_PATH`）。

## 関連ドキュメント

- 検出ポリシーと転送選択: [Discovery](/gateway/discovery)
- ノードのペアリングと承認: [Gateway pairing](/gateway/pairing)
