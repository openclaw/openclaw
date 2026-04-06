---
read_when:
    - iOSノードのペアリングまたは再接続を行う場合
    - iOSアプリをソースから実行する場合
    - Gateway ゲートウェイのディスカバリーまたはキャンバスコマンドをデバッグする場合
summary: iOSノードアプリ：Gateway ゲートウェイへの接続、ペアリング、キャンバス、トラブルシューティング
title: iOSアプリ
x-i18n:
    generated_at: "2026-04-02T07:47:52Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: b070f98b7aec53873196ee6d4f5eb6ee505eae16e37f9c8f08e9fbbca2fcfb09
    source_path: platforms/ios.md
    workflow: 15
---

# iOSアプリ（ノード）

利用可能状況：内部プレビュー。iOSアプリはまだ一般公開されていない。

## 機能

- WebSocket経由でGateway ゲートウェイに接続する（LANまたはtailnet）。
- ノード機能を公開する：キャンバス、スクリーンスナップショット、カメラキャプチャ、位置情報、トークモード、ボイスウェイク。
- `node.invoke`コマンドを受信し、ノードステータスイベントを報告する。

## 要件

- 別のデバイス（macOS、Linux、またはWSL2経由のWindows）でGateway ゲートウェイが実行されていること。
- ネットワークパス：
  - Bonjour経由の同一LAN、**または**
  - ユニキャストDNS-SD経由のtailnet（ドメイン例：`openclaw.internal.`）、**または**
  - 手動ホスト/ポート（フォールバック）。

## クイックスタート（ペアリング + 接続）

1. Gateway ゲートウェイを起動する：

```bash
openclaw gateway --port 18789
```

2. iOSアプリで設定を開き、検出されたGateway ゲートウェイを選択する（または手動ホストを有効にしてホスト/ポートを入力する）。

3. Gateway ゲートウェイホストでペアリングリクエストを承認する：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

アプリが認証情報（ロール/スコープ/公開鍵）を変更してペアリングを再試行した場合、前回の保留中のリクエストは置き換えられ、新しい`requestId`が作成される。
承認前に`openclaw devices list`を再度実行すること。

4. 接続を確認する：

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 公式ビルド向けリレーベースのプッシュ

公式配布のiOSビルドは、生のAPNsトークンをGateway ゲートウェイに公開する代わりに、外部プッシュリレーを使用する。

Gateway ゲートウェイ側の要件：

```json5
{
  gateway: {
    push: {
      apns: {
        relay: {
          baseUrl: "https://relay.example.com",
        },
      },
    },
  },
}
```

フローの動作：

- iOSアプリはApp Attestとアプリレシートを使用してリレーに登録する。
- リレーは不透明なリレーハンドルと登録スコープの送信グラントを返す。
- iOSアプリはペアリング済みのGateway ゲートウェイIDを取得し、リレー登録に含める。これにより、リレーベースの登録はその特定のGateway ゲートウェイに委任される。
- アプリはそのリレーベースの登録を`push.apns.register`でペアリング済みのGateway ゲートウェイに転送する。
- Gateway ゲートウェイは保存されたリレーハンドルを`push.test`、バックグラウンドウェイク、ウェイクナッジに使用する。
- Gateway ゲートウェイのリレーベースURLは、公式/TestFlightのiOSビルドに組み込まれたリレーURLと一致する必要がある。
- アプリが後で別のGateway ゲートウェイや異なるリレーベースURLのビルドに接続した場合、古いバインディングを再利用せずリレー登録を更新する。

このパスでGateway ゲートウェイに**不要**なもの：

- デプロイメント全体のリレートークンは不要。
- 公式/TestFlightのリレーベース送信用の直接APNsキーは不要。

想定されるオペレーターフロー：

1. 公式/TestFlightのiOSビルドをインストールする。
2. Gateway ゲートウェイに`gateway.push.apns.relay.baseUrl`を設定する。
3. アプリをGateway ゲートウェイにペアリングし、接続が完了するのを待つ。
4. アプリはAPNsトークンを取得し、オペレーターセッションが接続され、リレー登録が成功した後、自動的に`push.apns.register`を発行する。
5. その後、`push.test`、再接続ウェイク、ウェイクナッジは保存されたリレーベースの登録を使用できる。

互換性に関する注意：

- `OPENCLAW_APNS_RELAY_BASE_URL`はGateway ゲートウェイの一時的な環境変数オーバーライドとして引き続き機能する。

## 認証と信頼フロー

リレーは、公式iOSビルドにおいてGateway ゲートウェイ上の直接APNsでは提供できない2つの制約を強制するために存在する：

- Appleを通じて配布された正規のOpenClaw iOSビルドのみがホスト型リレーを使用できる。
- Gateway ゲートウェイは、その特定のGateway ゲートウェイにペアリングしたiOSデバイスに対してのみリレーベースのプッシュを送信できる。

ホップごとの詳細：

1. `iOSアプリ -> Gateway ゲートウェイ`
   - アプリはまず通常のGateway ゲートウェイ認証フローを通じてGateway ゲートウェイとペアリングする。
   - これにより、アプリは認証済みのノードセッションと認証済みのオペレーターセッションを取得する。
   - オペレーターセッションは`gateway.identity.get`の呼び出しに使用される。

2. `iOSアプリ -> リレー`
   - アプリはHTTPS経由でリレー登録エンドポイントを呼び出す。
   - 登録にはApp Attestの証明とアプリレシートが含まれる。
   - リレーはバンドルID、App Attestの証明、Appleレシートを検証し、公式/本番配布パスを要求する。
   - これがローカルのXcode/開発ビルドからホスト型リレーの使用をブロックする仕組みである。ローカルビルドは署名されていても、リレーが期待する公式Apple配布証明を満たさない。

3. `Gateway ゲートウェイID委任`
   - リレー登録の前に、アプリは`gateway.identity.get`からペアリング済みのGateway ゲートウェイIDを取得する。
   - アプリはそのGateway ゲートウェイIDをリレー登録ペイロードに含める。
   - リレーはそのGateway ゲートウェイIDに委任されたリレーハンドルと登録スコープの送信グラントを返す。

4. `Gateway ゲートウェイ -> リレー`
   - Gateway ゲートウェイは`push.apns.register`からのリレーハンドルと送信グラントを保存する。
   - `push.test`、再接続ウェイク、ウェイクナッジの際に、Gateway ゲートウェイは自身のデバイスIDで送信リクエストに署名する。
   - リレーは保存された送信グラントと、登録時に委任されたGateway ゲートウェイIDに対するGateway ゲートウェイ署名の両方を検証する。
   - 別のGateway ゲートウェイは、たとえハンドルを入手したとしても、その保存された登録を再利用できない。

5. `リレー -> APNs`
   - リレーは本番APNs資格情報と公式ビルドの生のAPNsトークンを所有する。
   - Gateway ゲートウェイはリレーベースの公式ビルドの生のAPNsトークンを保存しない。
   - リレーはペアリング済みGateway ゲートウェイに代わって最終プッシュをAPNsに送信する。

この設計が作られた理由：

- 本番APNs資格情報をユーザーのGateway ゲートウェイから排除するため。
- Gateway ゲートウェイに公式ビルドの生のAPNsトークンを保存しないため。
- ホスト型リレーの使用を公式/TestFlightのOpenClawビルドに限定するため。
- あるGateway ゲートウェイが別のGateway ゲートウェイが所有するiOSデバイスにウェイクプッシュを送信することを防ぐため。

ローカル/手動ビルドは直接APNsを引き続き使用する。リレーなしでこれらのビルドをテストする場合、Gateway ゲートウェイには直接APNs資格情報が必要：

```bash
export OPENCLAW_APNS_TEAM_ID="TEAMID"
export OPENCLAW_APNS_KEY_ID="KEYID"
export OPENCLAW_APNS_PRIVATE_KEY_P8="$(cat /path/to/AuthKey_KEYID.p8)"
```

## ディスカバリーパス

### Bonjour（LAN）

Gateway ゲートウェイは`local.`上で`_openclaw-gw._tcp`をアドバタイズする。iOSアプリはこれらを自動的にリスト表示する。

### Tailnet（クロスネットワーク）

mDNSがブロックされている場合は、ユニキャストDNS-SDゾーン（ドメインを選択、例：`openclaw.internal.`）とTailscaleのスプリットDNSを使用する。
CoreDNSの例は[Bonjour](/gateway/bonjour)を参照。

### 手動ホスト/ポート

設定で**手動ホスト**を有効にし、Gateway ゲートウェイのホスト + ポート（デフォルト`18789`）を入力する。

## キャンバス + A2UI

iOSノードはWKWebViewキャンバスをレンダリングする。`node.invoke`で制御する：

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18789/__openclaw__/canvas/"}'
```

注意：

- Gateway ゲートウェイのキャンバスホストは`/__openclaw__/canvas/`と`/__openclaw__/a2ui/`を提供する。
- Gateway ゲートウェイHTTPサーバー（`gateway.port`と同じポート、デフォルト`18789`）から提供される。
- iOSノードはキャンバスホストURLがアドバタイズされると、接続時に自動的にA2UIに遷移する。
- 組み込みスキャフォールドに戻るには`canvas.navigate`で`{"url":""}`を使用する。

### キャンバスeval / スナップショット

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## ボイスウェイク + トークモード

- ボイスウェイクとトークモードは設定で利用可能。
- iOSはバックグラウンドオーディオを中断する場合がある。アプリがアクティブでない場合、音声機能はベストエフォートとして扱うこと。

## よくあるエラー

- `NODE_BACKGROUND_UNAVAILABLE`：iOSアプリをフォアグラウンドに移動する（キャンバス/カメラ/スクリーンコマンドはフォアグラウンドが必要）。
- `A2UI_HOST_NOT_CONFIGURED`：Gateway ゲートウェイがキャンバスホストURLをアドバタイズしなかった。[Gateway ゲートウェイ設定](/gateway/configuration)の`canvasHost`を確認する。
- ペアリングプロンプトが表示されない：`openclaw devices list`を実行して手動で承認する。
- 再インストール後に再接続に失敗する：キーチェーンのペアリングトークンがクリアされた。ノードを再ペアリングする。

## 関連ドキュメント

- [ペアリング](/channels/pairing)
- [ディスカバリー](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
