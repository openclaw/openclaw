---
summary: "ブリッジプロトコル（レガシーノード）：TCP JSONL、ペアリング、スコープ付き RPC"
read_when:
  - iOS/Android/macOS のノードモードでノードクライアントを構築またはデバッグする場合
  - ペアリングまたはブリッジ認証の失敗を調査する場合
  - ゲートウェイによって公開されるノードのサーフェスを監査する場合
title: "ブリッジプロトコル"
---

# ブリッジプロトコル（レガシー ノード トランスポート）

ブリッジプロトコルは **レガシー** のノード トランスポート（TCP JSONL）です。新しいノードクライアントでは、代わりに統合された Gateway WebSocket プロトコルを使用する必要があります。 新しいノードクライアント
は、代わりに統合されたGateway WebSocketプロトコルを使用する必要があります。

オペレーターまたはノードクライアントを構築している場合は、
[Gateway プロトコル](/gateway/protocol) を使用してください。

**注記:** 現在の OpenClaw ビルドには TCP ブリッジ リスナーは同梱されていません。本ドキュメントは履歴参照のために保持されています。
レガシーの `bridge.*` 設定キーは、もはや設定スキーマの一部ではありません。
従来の `bridge.*` 設定キーは設定スキーマの一部ではなくなりました。

## 両方が存在する理由

- **セキュリティ境界**: ブリッジは、完全な ゲートウェイ API サーフェスではなく、小さな 許可リスト を公開します。
- **ペアリング + ノード ID**: ノードの受け入れは ゲートウェイ によって管理され、ノードごとのトークンに紐づきます。
- **検出 UX**: ノードは LAN 上で Bonjour により ゲートウェイ を検出するか、tailnet 経由で直接接続できます。
- **ループバック WS**: 完全な WS コントロールプレーンは、SSH 経由でトンネルしない限りローカルに留まります。

## トランスポート

- TCP、1 行につき 1 つの JSON オブジェクト（JSONL）。
- オプションの TLS（`bridge.tls.enabled` が true の場合）。
- レガシーのデフォルト リスナー ポートは `18790` でした（現在のビルドでは TCP ブリッジは起動しません）。

TLS が有効な場合、検出 TXT レコードには `bridgeTls=1` と
`bridgeTlsSha256` が含まれ、ノードは証明書をピン留めできます。

## ハンドシェイク + ペアリング

1. クライアントは、ノード メタデータ + トークン（既にペアリング済みの場合）を含む `hello` を送信します。
2. 未ペアリングの場合、ゲートウェイ は `error`（`NOT_PAIRED`/`UNAUTHORIZED`）で応答します。
3. クライアントは `pair-request` を送信します。
4. ゲートウェイ は承認を待機し、その後 `pair-ok` と `hello-ok` を送信します。

`hello-ok` は `serverName` を返し、`canvasHostUrl` を含む場合があります。

## フレーム

クライアント → ゲートウェイ:

- `req` / `res`: スコープ付き ゲートウェイ RPC（chat、sessions、config、health、voicewake、skills.bins）
- `event`: ノード シグナル（音声書き起こし、エージェント リクエスト、チャット購読、exec ライフサイクル）

ゲートウェイ → クライアント:

- `invoke` / `invoke-res`: ノード コマンド（`canvas.*`、`camera.*`、`screen.record`、
  `location.get`、`sms.send`）
- `event`: 購読された セッション 向けの チャット 更新
- `ping` / `pong`: キープアライブ

レガシーの 許可リスト 強制は `src/gateway/server-bridge.ts` に存在していました（削除済み）。

## Exec ライフサイクル イベント

ノードは、system.run のアクティビティを表面化するために `exec.finished` または `exec.denied` イベントを送出できます。
これらは ゲートウェイ 内の system イベントにマッピングされます。（レガシー ノードでは、引き続き `exec.started` を送出する場合があります。）
これらはゲートウェイ内のシステムイベントにマッピングされます。 (レガシーノードはまだ `exec.started` を出力することができます。

ペイロード フィールド（特記がない限りすべて任意）:

- `sessionKey`（必須）: system イベントを受信する エージェント セッション。
- `runId`: グルーピングのための一意な exec ID。
- `command`: 生または整形済みの コマンド 文字列。
- `exitCode`、`timedOut`、`success`、`output`: 完了の詳細（finished のみ）。
- `reason`: 拒否理由（denied のみ）。

## Tailnet の使用

- ブリッジを tailnet IP にバインドします: `bridge.bind: "tailnet"` を
  `~/.openclaw/openclaw.json` に設定します。
- クライアントは MagicDNS 名または tailnet IP 経由で接続します。
- Bonjour は **ネットワークを跨ぎません**。必要に応じて、手動の ホスト/ポート または 広域 DNS‑SD を使用してください。

## Versioning

Bridge is currently **implicit v1** (no min/max negotiation). ブリッジは現在 **暗黙の v1**（最小/最大のネゴシエーションなし）です。後方互換性が期待されます。破壊的変更の前には、ブリッジ プロトコルの バージョン フィールドを追加してください。
