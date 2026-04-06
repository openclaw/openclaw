---
read_when:
    - Androidノードのペアリングまたは再接続を行う場合
    - AndroidのGateway ゲートウェイディスカバリーや認証をデバッグする場合
    - クライアント間のチャット履歴の一致を検証する場合
summary: 'Androidアプリ（ノード）: 接続手順 + Connect/Chat/Voice/Canvasコマンドサーフェス'
title: Androidアプリ
x-i18n:
    generated_at: "2026-04-02T07:47:24Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a108f3b5b3e3d9973b311c1e8c3dea66b0d711be30c4c81788469507c9785fb7
    source_path: platforms/android.md
    workflow: 15
---

# Androidアプリ（ノード）

> **注意:** Androidアプリはまだ一般公開されていません。ソースコードは[OpenClawリポジトリ](https://github.com/openclaw/openclaw)の `apps/android` にあります。Java 17とAndroid SDKを使用して自分でビルドできます（`./gradlew :app:assemblePlayDebug`）。ビルド手順は[apps/android/README.md](https://github.com/openclaw/openclaw/blob/main/apps/android/README.md)を参照してください。

## サポート概要

- 役割: コンパニオンノードアプリ（AndroidはGateway ゲートウェイをホストしません）。
- Gateway ゲートウェイが必要: はい（macOS、Linux、またはWSL2経由のWindowsで実行してください）。
- インストール: [はじめに](/start/getting-started) + [ペアリング](/channels/pairing)。
- Gateway ゲートウェイ: [手順書](/gateway) + [設定](/gateway/configuration)。
  - プロトコル: [Gateway ゲートウェイプロトコル](/gateway/protocol)（ノード + コントロールプレーン）。

## システム制御

システム制御（launchd/systemd）はGateway ゲートウェイホスト上で行います。[Gateway ゲートウェイ](/gateway)を参照してください。

## 接続手順

Androidノードアプリ ⇄（mDNS/NSD + WebSocket）⇄ **Gateway ゲートウェイ**

AndroidはGateway ゲートウェイのWebSocket（デフォルト `ws://<host>:18789`）に直接接続し、デバイスペアリング（`role: node`）を使用します。

### 前提条件

- 「マスター」マシンでGateway ゲートウェイを実行できること。
- Androidデバイス/エミュレーターがGateway ゲートウェイのWebSocketに到達できること:
  - mDNS/NSDを使用した同一LAN、**または**
  - Wide-Area Bonjour / ユニキャストDNS-SDを使用した同一Tailscaleテールネット（下記参照）、**または**
  - 手動によるGateway ゲートウェイホスト/ポート指定（フォールバック）
- Gateway ゲートウェイマシンでCLI（`openclaw`）を実行できること（またはSSH経由）。

### 1) Gateway ゲートウェイの起動

```bash
openclaw gateway --port 18789 --verbose
```

ログに以下のような出力が表示されることを確認してください:

- `listening on ws://0.0.0.0:18789`

テールネット専用のセットアップ（Vienna ⇄ London に推奨）の場合、Gateway ゲートウェイをテールネットIPにバインドします:

- Gateway ゲートウェイホストの `~/.openclaw/openclaw.json` で `gateway.bind: "tailnet"` を設定します。
- Gateway ゲートウェイ / macOSメニューバーアプリを再起動します。

### 2) ディスカバリーの確認（任意）

Gateway ゲートウェイマシンから:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

デバッグの詳細: [Bonjour](/gateway/bonjour)。

#### テールネット（Vienna ⇄ London）でのユニキャストDNS-SDによるディスカバリー

Android NSD/mDNSディスカバリーはネットワークを越えられません。AndroidノードとGateway ゲートウェイが異なるネットワーク上にあり、Tailscaleで接続されている場合は、Wide-Area Bonjour / ユニキャストDNS-SDを使用してください:

1. Gateway ゲートウェイホストにDNS-SDゾーン（例: `openclaw.internal.`）をセットアップし、`_openclaw-gw._tcp` レコードを公開します。
2. 選択したドメインのTailscaleスプリットDNSをそのDNSサーバーに向けて設定します。

詳細とCoreDNS設定例: [Bonjour](/gateway/bonjour)。

### 3) Androidからの接続

Androidアプリで:

- アプリは**フォアグラウンドサービス**（永続的な通知）を使用してGateway ゲートウェイ接続を維持します。
- **Connect**タブを開きます。
- **セットアップコード**または**手動**モードを使用します。
- ディスカバリーがブロックされている場合は、**詳細設定**で手動のホスト/ポート（および必要に応じてTLS/トークン/パスワード）を使用します。

最初のペアリングが成功すると、Androidは起動時に自動再接続します:

- 手動エンドポイント（有効な場合）、そうでなければ
- 最後にディスカバリーされたGateway ゲートウェイ（ベストエフォート）。

### 4) ペアリングの承認（CLI）

Gateway ゲートウェイマシンで:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

ペアリングの詳細: [ペアリング](/channels/pairing)。

### 5) ノードの接続確認

- ノードステータスで確認:

  ```bash
  openclaw nodes status
  ```

- Gateway ゲートウェイ経由で確認:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) チャット + 履歴

AndroidのChatタブはセッション選択をサポートしています（デフォルトは `main` に加え、既存の他のセッション）:

- 履歴: `chat.history`
- 送信: `chat.send`
- プッシュ更新（ベストエフォート）: `chat.subscribe` → `event:"chat"`

### 7) Canvas + カメラ

#### Gateway ゲートウェイCanvasホスト（Webコンテンツに推奨）

ノードにエージェントがディスク上で編集できる実際のHTML/CSS/JSを表示させたい場合は、ノードをGateway ゲートウェイのCanvasホストに向けます。

注意: ノードはGateway ゲートウェイのHTTPサーバー（`gateway.port` と同じポート、デフォルト `18789`）からCanvasを読み込みます。

1. Gateway ゲートウェイホストに `~/.openclaw/workspace/canvas/index.html` を作成します。

2. ノードをそこにナビゲートします（LAN）:

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

Tailscale（任意）: 両方のデバイスがTailscale上にある場合、`.local` の代わりにMagicDNS名またはテールネットIPを使用します（例: `http://<gateway-magicdns>:18789/__openclaw__/canvas/`）。

このサーバーはHTMLにライブリロードクライアントを注入し、ファイル変更時にリロードします。
A2UIホストは `http://<gateway-host>:18789/__openclaw__/a2ui/` にあります。

Canvasコマンド（フォアグラウンドのみ）:

- `canvas.eval`、`canvas.snapshot`、`canvas.navigate`（デフォルトのスキャフォールドに戻るには `{"url":""}` または `{"url":"/"}` を使用）。`canvas.snapshot` は `{ format, base64 }` を返します（デフォルト `format="jpeg"`）。
- A2UI: `canvas.a2ui.push`、`canvas.a2ui.reset`（`canvas.a2ui.pushJSONL` はレガシーエイリアス）

カメラコマンド（フォアグラウンドのみ、権限が必要）:

- `camera.snap`（jpg）
- `camera.clip`（mp4）

パラメータとCLIヘルパーについては[カメラノード](/nodes/camera)を参照してください。

### 8) 音声 + 拡張Androidコマンドサーフェス

- 音声: AndroidはVoiceタブで単一のマイクオン/オフフローを使用し、トランスクリプトキャプチャとTTS再生（設定時はElevenLabs、フォールバックとしてシステムTTS）を行います。アプリがフォアグラウンドを離れると音声は停止します。
- Voice Wakeとトークモードのトグルは、現在AndroidのUX/ランタイムから削除されています。
- 追加のAndroidコマンドファミリー（デバイスと権限に応じて利用可能）:
  - `device.status`、`device.info`、`device.permissions`、`device.health`
  - `notifications.list`、`notifications.actions`（下記の[通知転送](#notification-forwarding)を参照）
  - `photos.latest`
  - `contacts.search`、`contacts.add`
  - `calendar.events`、`calendar.add`
  - `callLog.search`
  - `sms.search`
  - `motion.activity`、`motion.pedometer`

## 通知転送

Androidはデバイスの通知をイベントとしてGateway ゲートウェイに転送できます。いくつかの設定で、どの通知をいつ転送するかを制御できます。

| キー                              | 型             | 説明                                                                                       |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `notifications.allowPackages`    | string[]       | これらのパッケージ名からの通知のみを転送します。設定すると、他のすべてのパッケージは無視されます。      |
| `notifications.denyPackages`     | string[]       | これらのパッケージ名からの通知を転送しません。`allowPackages` の後に適用されます。              |
| `notifications.quietHours.start` | string (HH:mm) | 静音時間ウィンドウの開始時刻（デバイスのローカル時間）。この間、通知は抑制されます。 |
| `notifications.quietHours.end`   | string (HH:mm) | 静音時間ウィンドウの終了時刻。                                                                        |
| `notifications.rateLimit`        | number         | パッケージごとの1分あたりの最大転送通知数。超過した通知は破棄されます。         |

通知ピッカーは転送された通知イベントに対してより安全な動作も使用し、機密性の高いシステム通知の誤転送を防ぎます。

設定例:

```json5
{
  notifications: {
    allowPackages: ["com.slack", "com.whatsapp"],
    denyPackages: ["com.android.systemui"],
    quietHours: {
      start: "22:00",
      end: "07:00",
    },
    rateLimit: 5,
  },
}
```

<Note>
通知転送にはAndroidの通知リスナー権限が必要です。アプリはセットアップ中にこの権限を求めるプロンプトを表示します。
</Note>
