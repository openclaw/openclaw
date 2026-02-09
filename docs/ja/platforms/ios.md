---
summary: "iOS ノードアプリ：Gateway への接続、ペアリング、キャンバス、トラブルシューティング"
read_when:
  - iOS ノードのペアリングまたは再接続を行うとき
  - ソースから iOS アプリを実行するとき
  - ゲートウェイ検出やキャンバスコマンドをデバッグするとき
title: "iOS アプリ"
---

# iOS アプリ（ノード）

可用性: 内部プレビュー。 提供状況：内部プレビュー。iOS アプリはまだ一般公開されていません。

## 何を行うか

- WebSocket（LAN または tailnet）経由で Gateway（ゲートウェイ）に接続します。
- ノードの機能を公開します：Canvas、画面スナップショット、カメラキャプチャ、位置情報、トークモード、音声ウェイク。
- `node.invoke` コマンドを受信し、ノードのステータスイベントを報告します。

## 要件

- 別のデバイスで稼働している Gateway（macOS、Linux、または WSL2 経由の Windows）。
- ネットワーク経路：
  - Bonjour 経由の同一 LAN、**または**
  - ユニキャスト DNS-SD（例のドメイン：`openclaw.internal.`）を用いた Tailnet、**または**
  - 手動のホスト／ポート（フォールバック）。

## クイックスタート（ペアリング＋接続）

1. Gateway を起動します：

```bash
openclaw gateway --port 18789
```

2. iOS アプリで「設定」を開き、検出されたゲートウェイを選択します（または「手動ホスト」を有効にしてホスト／ポートを入力します）。

3. ゲートウェイ ホストでペアリング要求を承認します：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. 接続を確認します：

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 検出経路

### Bonjour（LAN）

Gateway は `_openclaw-gw._tcp` を `local.` でアドバタイズします。iOS アプリはこれらを自動的に一覧表示します。 iOSアプリはこれらを自動的に一覧表示します。

### Tailnet（クロスネットワーク）

mDNS がブロックされている場合は、ユニキャスト DNS-SD ゾーン（ドメインを選択。例：`openclaw.internal.`）と Tailscale の分割 DNS を使用します。
CoreDNS の例については [Bonjour](/gateway/bonjour) を参照してください。
CoreDNSの例については、 [Bonjour](/gateway/bonjour) を参照してください。

### 手動ホスト／ポート

「設定」で **手動ホスト** を有効にし、ゲートウェイのホスト＋ポート（デフォルト：`18789`）を入力します。

## Canvas ＋ A2UI

iOS ノードは WKWebView キャンバスをレンダリングします。`node.invoke` を使用して操作します： `node.invoke` を使用してドライブします。

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

注記：

- Gateway のキャンバスホストは `/__openclaw__/canvas/` と `/__openclaw__/a2ui/` を提供します。
- キャンバスホスト URL がアドバタイズされている場合、iOS ノードは接続時に自動で A2UI にナビゲートします。
- `canvas.navigate` と `{"url":""}` で、組み込みのスキャフォールドに戻ります。

### Canvas の eval／スナップショット

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## 音声ウェイク＋トークモード

- 音声ウェイクとトークモードは「設定」から利用できます。
- iOS はバックグラウンド音声を停止する場合があります。アプリが非アクティブなときの音声機能は、ベストエフォートとして扱ってください。

## よくあるエラー

- `NODE_BACKGROUND_UNAVAILABLE`：iOS アプリをフォアグラウンドにしてください（キャンバス／カメラ／画面コマンドには必要です）。
- `A2UI_HOST_NOT_CONFIGURED`：Gateway がキャンバスホスト URL をアドバタイズしていません。[Gateway 設定](/gateway/configuration) の `canvasHost` を確認してください。
- ペアリングのプロンプトが表示されない：`openclaw nodes pending` を実行し、手動で承認してください。
- 再インストール後に再接続できない：Keychain のペアリングトークンがクリアされています。ノードを再ペアリングしてください。

## 関連ドキュメント

- [ペアリング](/gateway/pairing)
- [検出](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
