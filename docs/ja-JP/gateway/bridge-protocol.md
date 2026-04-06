---
read_when:
    - ノードクライアント（iOS/Android/macOSノードモード）の構築またはデバッグ時
    - ペアリングまたはブリッジ認証の失敗を調査する場合
    - Gateway ゲートウェイが公開するノードサーフェスを監査する場合
summary: 'ブリッジプロトコル（レガシーノード）: TCP JSONL、ペアリング、スコープ付きRPC'
title: ブリッジプロトコル
x-i18n:
    generated_at: "2026-04-02T07:40:54Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 1252702833436f00cb14eb07769155fed788147744f1c0df906292f2708f2914
    source_path: gateway/bridge-protocol.md
    workflow: 15
---

# ブリッジプロトコル（レガシーノードトランスポート）

<Warning>
TCPブリッジは**削除されました**。現在のOpenClawビルドにはブリッジリスナーは含まれておらず、`bridge.*`設定キーはスキーマに存在しません。このページは歴史的な参考資料としてのみ保持されています。すべてのノード/オペレータークライアントには[Gateway ゲートウェイプロトコル](/gateway/protocol)を使用してください。
</Warning>

## 両方が存在する理由

- **セキュリティ境界**: ブリッジはGateway ゲートウェイAPIサーフェス全体ではなく、小さな許可リストのみを公開します。
- **ペアリング + ノードアイデンティティ**: ノードの受け入れはGateway ゲートウェイが管理し、ノードごとのトークンに紐づけられます。
- **ディスカバリーUX**: ノードはLAN上のBonjourを介してGateway ゲートウェイを検出するか、tailnet経由で直接接続できます。
- **ループバックWS**: 完全なWSコントロールプレーンは、SSHでトンネルされない限りローカルに留まります。

## トランスポート

- TCP、1行に1つのJSONオブジェクト（JSONL）。
- オプションのTLS（`bridge.tls.enabled`がtrueの場合）。
- レガシーのデフォルトリスナーポートは`18790`でした（現在のビルドではTCPブリッジは起動しません）。

TLSが有効な場合、ディスカバリーTXTレコードには`bridgeTls=1`と、非秘密のヒントとして`bridgeTlsSha256`が含まれます。Bonjour/mDNS TXTレコードは認証されていないため、明示的なユーザーの意図やその他の帯域外検証なしに、アドバタイズされたフィンガープリントを権威あるピンとして扱ってはなりません。

## ハンドシェイク + ペアリング

1. クライアントがノードメタデータとトークン（既にペアリング済みの場合）を含む`hello`を送信。
2. ペアリングされていない場合、Gateway ゲートウェイが`error`（`NOT_PAIRED`/`UNAUTHORIZED`）を返信。
3. クライアントが`pair-request`を送信。
4. Gateway ゲートウェイが承認を待ち、`pair-ok`と`hello-ok`を送信。

`hello-ok`は`serverName`を返し、`canvasHostUrl`を含む場合があります。

## フレーム

クライアント → Gateway ゲートウェイ:

- `req` / `res`: スコープ付きGateway ゲートウェイRPC（chat、sessions、config、health、voicewake、skills.bins）
- `event`: ノードシグナル（音声トランスクリプト、エージェントリクエスト、チャットサブスクライブ、exec ライフサイクル）

Gateway ゲートウェイ → クライアント:

- `invoke` / `invoke-res`: ノードコマンド（`canvas.*`、`camera.*`、`screen.record`、
  `location.get`、`sms.send`）
- `event`: サブスクライブ済みセッションのチャット更新
- `ping` / `pong`: キープアライブ

レガシーの許可リスト適用は`src/gateway/server-bridge.ts`に存在していました（削除済み）。

## Execライフサイクルイベント

ノードは`exec.finished`または`exec.denied`イベントを発行して、system.runのアクティビティを表面化できます。
これらはGateway ゲートウェイ内でシステムイベントにマッピングされます。（レガシーノードは引き続き`exec.started`を発行する場合があります。）

ペイロードフィールド（特記がない限りすべてオプション）:

- `sessionKey`（必須）: システムイベントを受信するエージェントセッション。
- `runId`: グループ化のための一意のexec ID。
- `command`: 生またはフォーマット済みのコマンド文字列。
- `exitCode`、`timedOut`、`success`、`output`: 完了の詳細（finishedのみ）。
- `reason`: 拒否理由（deniedのみ）。

## Tailnetの使用

- ブリッジをtailnet IPにバインド: `~/.openclaw/openclaw.json`内で`bridge.bind: "tailnet"`を設定。
- クライアントはMagicDNS名またはtailnet IP経由で接続。
- Bonjourはネットワークを**越えません**。必要に応じて手動のホスト/ポートまたはワイドエリアDNS-SDを使用してください。

## バージョニング

ブリッジは現在**暗黙のv1**です（min/maxネゴシエーションなし）。後方互換性が想定されています。破壊的変更を行う前にブリッジプロトコルバージョンフィールドを追加してください。
