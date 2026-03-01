---
summary: "Android アプリ（ノード）：接続の運用手順書 + Canvas/Chat/Camera"
read_when:
  - Android ノードのペアリングまたは再接続
  - Android の Gateway 検出や認証のデバッグ
  - クライアント間のチャット履歴の整合性確認
title: "Android アプリ"
---

# Android アプリ（ノード）

## サポート状況

- 役割：コンパニオンノードアプリ（Android は Gateway をホストしません）。
- Gateway 必須：はい（macOS、Linux、または Windows の WSL2 で実行してください）。
- インストール：[はじめに](/start/getting-started) + [ペアリング](/gateway/pairing)。
- Gateway：[運用手順書](/gateway) + [設定](/gateway/configuration)。
  - プロトコル：[Gateway プロトコル](/gateway/protocol)（ノード + コントロールプレーン）。

## システム制御

システム制御（launchd/systemd）は Gateway ホスト上にあります。[Gateway](/gateway) を参照してください。

## 接続の運用手順書

Android ノードアプリ ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android は Gateway の WebSocket（デフォルト `ws://<host>:18789`）に直接接続し、Gateway 側のペアリングを使用します。

### 前提条件

- 「マスター」マシンで Gateway を実行できること。
- Android デバイス/エミュレーターが Gateway の WebSocket に到達できること：
  - mDNS/NSD を使用した同一 LAN、**または**
  - Wide-Area Bonjour / ユニキャスト DNS-SD を使用した同一 Tailscale tailnet（後述）、**または**
  - 手動での Gateway ホスト/ポート指定（フォールバック）
- Gateway マシンで CLI（`openclaw`）を実行できること（または SSH 経由で）。

### 1) Gateway を起動する

```bash
openclaw gateway --port 18789 --verbose
```

ログに以下のような出力が表示されることを確認してください：

- `listening on ws://0.0.0.0:18789`

tailnet 専用のセットアップ（Vienna ⇄ London に推奨）の場合、Gateway を tailnet IP にバインドします：

- Gateway ホストの `~/.openclaw/openclaw.json` で `gateway.bind: "tailnet"` を設定します。
- Gateway / macOS メニューバーアプリを再起動します。

### 2) 検出の確認（オプション）

Gateway マシンから：

```bash
dns-sd -B _openclaw-gw._tcp local.
```

デバッグに関する詳細：[Bonjour](/gateway/bonjour)。

#### Tailnet（Vienna ⇄ London）のユニキャスト DNS-SD による検出

Android の NSD/mDNS 検出はネットワークを越えられません。Android ノードと Gateway が異なるネットワーク上にあり、Tailscale で接続されている場合は、代わりに Wide-Area Bonjour / ユニキャスト DNS-SD を使用してください：

1. Gateway ホスト上に DNS-SD ゾーン（例：`openclaw.internal.`）をセットアップし、`_openclaw-gw._tcp` レコードを公開します。
2. 選択したドメインを指す Tailscale スプリット DNS を設定します。

詳細と CoreDNS の設定例：[Bonjour](/gateway/bonjour)。

### 3) Android から接続する

Android アプリで：

- アプリは**フォアグラウンドサービス**（永続的な通知）を通じて Gateway 接続を維持します。
- **設定**を開きます。
- **検出された Gateway** の下からお使いの Gateway を選択し、**接続**をタップします。
- mDNS がブロックされている場合は、**詳細設定 → 手動 Gateway**（ホスト + ポート）を使用し、**手動接続**をタップします。

初回のペアリング成功後、Android は起動時に自動再接続します：

- 手動エンドポイント（有効な場合）、またはそうでなければ
- 最後に検出された Gateway（ベストエフォート）。

### 4) ペアリングを承認する（CLI）

Gateway マシンで：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

ペアリングの詳細：[Gateway ペアリング](/gateway/pairing)。

### 5) ノードの接続を確認する

- ノードステータス経由：

  ```bash
  openclaw nodes status
  ```

- Gateway 経由：

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) チャット + 履歴

Android ノードのチャットシートは Gateway の**プライマリセッションキー**（`main`）を使用するため、履歴と返信は WebChat や他のクライアントと共有されます：

- 履歴：`chat.history`
- 送信：`chat.send`
- プッシュ更新（ベストエフォート）：`chat.subscribe` → `event:"chat"`

### 7) Canvas + カメラ

#### Gateway Canvas ホスト（Web コンテンツに推奨）

ノードにエージェントがディスク上で編集できる実際の HTML/CSS/JS を表示させたい場合は、ノードを Gateway Canvas ホストに向けます。

注意：ノードは Gateway の HTTP サーバー（`gateway.port` と同じポート、デフォルト `18789`）から Canvas を読み込みます。

1. Gateway ホスト上に `~/.openclaw/workspace/canvas/index.html` を作成します。

2. ノードをそこにナビゲートします（LAN）：

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

Tailnet（オプション）：両方のデバイスが Tailscale 上にある場合は、`.local` の代わりに MagicDNS 名または tailnet IP を使用してください（例：`http://<gateway-magicdns>:18789/__openclaw__/canvas/`）。

このサーバーは HTML にライブリロードクライアントを注入し、ファイル変更時にリロードします。
A2UI ホストは `http://<gateway-host>:18789/__openclaw__/a2ui/` にあります。

Canvas コマンド（フォアグラウンドのみ）：

- `canvas.eval`、`canvas.snapshot`、`canvas.navigate`（デフォルトのスキャフォールドに戻るには `{"url":""}` または `{"url":"/"}` を使用）。`canvas.snapshot` は `{ format, base64 }` を返します（デフォルト `format="jpeg"`）。
- A2UI：`canvas.a2ui.push`、`canvas.a2ui.reset`（`canvas.a2ui.pushJSONL` はレガシーエイリアス）

カメラコマンド（フォアグラウンドのみ、パーミッションゲートあり）：

- `camera.snap` (jpg)
- `camera.clip` (mp4)

パラメーターと CLI ヘルパーについては [Camera ノード](/nodes/camera) を参照してください。
