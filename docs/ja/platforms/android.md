---
summary: "Android アプリ（ノード）：接続ランブック + Canvas / Chat / Camera"
read_when:
  - Android ノードのペアリングまたは再接続を行う場合
  - Android ゲートウェイの検出や認証をデバッグする場合
  - クライアント間でチャット履歴の整合性を確認する場合
title: "Android アプリ"
---

# Android アプリ（ノード）

## サポート概要

- 役割：コンパニオンノードアプリ（Android は Gateway（ゲートウェイ）をホストしません）。
- Gateway 必須：はい（macOS、Linux、または Windows（WSL2 経由）で実行します）。
- インストール：[Getting Started](/start/getting-started) + [Pairing](/gateway/pairing)。
- Gateway：[Runbook](/gateway) + [Configuration](/gateway/configuration)。
  - プロトコル：[Gateway protocol](/gateway/protocol)（ノード + コントロールプレーン）。

## システム制御

システム制御（launchd / systemd）は Gateway ホスト上にあります。[Gateway](/gateway) を参照してください。 [Gateway](/gateway) を参照してください。

## 接続ランブック

Android ノードアプリ ⇄（mDNS / NSD + WebSocket）⇄ **Gateway**

Android は Gateway WebSocket（デフォルト `ws://<host>:18789`）に直接接続し、Gateway が所有するペアリングを使用します。

### 前提条件

- 「マスター」マシンで Gateway を実行できること。
- Android デバイス / エミュレーターが Gateway WebSocket に到達できること：
  - mDNS / NSD を使用した同一 LAN、**または**
  - Wide-Area Bonjour / unicast DNS-SD を使用した同一 Tailscale tailnet（下記参照）、**または**
  - 手動でのゲートウェイホスト / ポート指定（フォールバック）
- ゲートウェイマシン上で CLI（`openclaw`）を実行できること（または SSH 経由）。

### 1. Gateway を起動する

```bash
openclaw gateway --port 18789 --verbose
```

ログに次のような出力が表示されることを確認してください：

- `listening on ws://0.0.0.0:18789`

tailnet 専用のセットアップ（Vienna ⇄ London には推奨）の場合は、Gateway を tailnet IP にバインドします：

- ゲートウェイホストの `~/.openclaw/openclaw.json` に `gateway.bind: "tailnet"` を設定します。
- Gateway / macOS メニューバーアプリを再起動します。

### 2. 検出を確認する（任意）

ゲートウェイマシンから：

```bash
dns-sd -B _openclaw-gw._tcp local.
```

追加のデバッグノート：[Bonjour](/gateway/bonjour)。

#### unicast DNS-SD による Tailnet（Vienna ⇄ London）検出

Android NSD/mDNSの検出はネットワークを越えません。 Android の NSD / mDNS 検出はネットワークを越えられません。Android ノードと Gateway が異なるネットワーク上にあり、Tailscale で接続されている場合は、Wide-Area Bonjour / unicast DNS-SD を使用してください：

1. ゲートウェイホストに DNS-SD ゾーン（例：`openclaw.internal.`）を設定し、`_openclaw-gw._tcp` レコードを公開します。
2. 選択したドメインをその DNS サーバーに向けるよう、Tailscale の split DNS を設定します。

詳細および CoreDNS 設定例：[Bonjour](/gateway/bonjour)。

### 3. Android から接続する

Android アプリ内で：

- アプリは **フォアグラウンドサービス**（永続通知）により Gateway への接続を維持します。
- **Settings** を開きます。
- **Discovered Gateways** から対象のゲートウェイを選択し、**Connect** をタップします。
- mDNS がブロックされている場合は、**Advanced → Manual Gateway**（ホスト + ポート）を使用し、**Connect (Manual)** を選択します。

最初のペアリングが成功すると、Android は起動時に自動再接続します：

- 手動エンドポイント（有効な場合）、それ以外は
- 最後に検出されたゲートウェイ（ベストエフォート）。

### 4. ペアリングを承認する（CLI）

ゲートウェイマシン上で：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

ペアリングの詳細：[Gateway pairing](/gateway/pairing)。

### 5. ノードが接続されていることを確認する

- ノードステータスから：

  ```bash
  openclaw nodes status
  ```

- Gateway から：

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. チャット + 履歴

Android ノードの Chat シートは、Gateway の **primary session key**（`main`）を使用するため、WebChat や他のクライアントと履歴および返信が共有されます：

- 履歴：`chat.history`
- 送信：`chat.send`
- プッシュ更新（ベストエフォート）：`chat.subscribe` → `event:"chat"`

### 7. Canvas + カメラ

#### Gateway Canvas Host（Web コンテンツ向けに推奨）

エージェントがディスク上のファイルを編集できる実際の HTML / CSS / JS をノードに表示したい場合は、ノードを Gateway の canvas host に向けてください。

注記：ノードは `canvasHost.port`（デフォルト `18793`）上のスタンドアロン canvas host を使用します。

1. ゲートウェイホスト上に `~/.openclaw/workspace/canvas/index.html` を作成します。

2. ノードからそれにアクセスします（LAN）：

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

tailnet（任意）：両方のデバイスが Tailscale 上にある場合は、`.local` の代わりに MagicDNS 名または tailnet IP を使用します（例：`http://<gateway-magicdns>:18793/__openclaw__/canvas/`）。

このサーバーは、HTML にライブリロードクライアントを注入し、ファイル変更時にリロードします。
このサーバーは HTML にライブリロードクライアントを注入し、ファイル変更時に再読み込みを行います。
A2UI ホストは `http://<gateway-host>:18793/__openclaw__/a2ui/` にあります。

Canvas コマンド（フォアグラウンドのみ）：

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (デフォルトの足場に戻るには`{"url":""}`または`{"url":"/"}`を使用します)。 `canvas.eval`、`canvas.snapshot`、`canvas.navigate`（デフォルトのスキャフォールドに戻るには `{"url":""}` または `{"url":"/"}` を使用します）。`canvas.snapshot` は `{ format, base64 }`（デフォルト `format="jpeg"`）を返します。
- A2UI：`canvas.a2ui.push`、`canvas.a2ui.reset`（`canvas.a2ui.pushJSONL` はレガシーエイリアス）

カメラコマンド（フォアグラウンドのみ、権限による制御あり）：

- `camera.snap`（jpg）
- `camera.clip`（mp4）

パラメーターおよび CLI ヘルパーについては [Camera node](/nodes/camera) を参照してください。
