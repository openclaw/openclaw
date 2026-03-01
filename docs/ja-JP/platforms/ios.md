---
summary: "iOS ノードアプリ：Gateway への接続、ペアリング、Canvas、トラブルシューティング"
read_when:
  - iOS ノードのペアリングまたは再接続
  - iOS アプリをソースから実行する
  - Gateway の検出や Canvas コマンドのデバッグ
title: "iOS アプリ"
---

# iOS アプリ（ノード）

利用可能状況：内部プレビュー。iOS アプリはまだ公開配布されていません。

## 機能

- WebSocket 経由で Gateway に接続します（LAN または tailnet）。
- ノード機能を公開します：Canvas、スクリーンスナップショット、カメラキャプチャー、位置情報、トークモード、ボイスウェイク。
- `node.invoke` コマンドを受信し、ノードステータスイベントを報告します。

## 要件

- 別のデバイス（macOS、Linux、または Windows の WSL2）で Gateway が動作していること。
- ネットワーク経路：
  - Bonjour 経由の同一 LAN、**または**
  - ユニキャスト DNS-SD 経由の tailnet（ドメイン例：`openclaw.internal.`）、**または**
  - 手動のホスト/ポート（フォールバック）。

## クイックスタート（ペアリング + 接続）

1. Gateway を起動します：

```bash
openclaw gateway --port 18789
```

2. iOS アプリで設定を開き、検出された Gateway を選択します（または手動ホストを有効にしてホスト/ポートを入力します）。

3. Gateway ホストでペアリングリクエストを承認します：

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

Gateway は `local.` 上で `_openclaw-gw._tcp` をアドバタイズします。iOS アプリはこれらを自動的にリストします。

### Tailnet（クロスネットワーク）

mDNS がブロックされている場合は、ユニキャスト DNS-SD ゾーン（ドメインを選択してください。例：`openclaw.internal.`）と Tailscale スプリット DNS を使用します。
CoreDNS の設定例については [Bonjour](/gateway/bonjour) を参照してください。

### 手動のホスト/ポート

設定で**手動ホスト**を有効にし、Gateway のホスト + ポート（デフォルト `18789`）を入力します。

## Canvas + A2UI

iOS ノードは WKWebView の Canvas をレンダリングします。`node.invoke` で操作します：

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18789/__openclaw__/canvas/"}'
```

注意：

- Gateway Canvas ホストは `/__openclaw__/canvas/` と `/__openclaw__/a2ui/` を提供します。
- Gateway の HTTP サーバー（`gateway.port` と同じポート、デフォルト `18789`）から提供されます。
- iOS ノードは Canvas ホスト URL がアドバタイズされている場合、接続時に A2UI に自動ナビゲートします。
- `canvas.navigate` と `{"url":""}` で組み込みスキャフォールドに戻ります。

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## ボイスウェイク + トークモード

- ボイスウェイクとトークモードは設定で利用可能です。
- iOS はバックグラウンドオーディオを一時停止する場合があります。アプリがアクティブでないときは、ボイス機能はベストエフォートとして扱ってください。

## よくあるエラー

- `NODE_BACKGROUND_UNAVAILABLE`：iOS アプリをフォアグラウンドに表示してください（Canvas/カメラ/スクリーンコマンドにはフォアグラウンドが必要です）。
- `A2UI_HOST_NOT_CONFIGURED`：Gateway が Canvas ホスト URL をアドバタイズしていません。[Gateway 設定](/gateway/configuration) の `canvasHost` を確認してください。
- ペアリングプロンプトが表示されない：`openclaw nodes pending` を実行して手動で承認してください。
- 再インストール後に再接続に失敗する：Keychain のペアリングトークンがクリアされています。ノードを再ペアリングしてください。

## 関連ドキュメント

- [ペアリング](/gateway/pairing)
- [検出](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
