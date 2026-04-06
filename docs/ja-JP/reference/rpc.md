---
read_when:
    - 外部CLI連携の追加または変更を行う場合
    - RPCアダプター（signal-cli、imsg）のデバッグを行う場合
summary: 外部CLI（signal-cli、レガシーimsg）向けRPCアダプターとGateway ゲートウェイパターン
title: RPCアダプター
x-i18n:
    generated_at: "2026-04-02T07:51:45Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 06dc6b97184cc704ba4ec4a9af90502f4316bcf717c3f4925676806d8b184c57
    source_path: reference/rpc.md
    workflow: 15
---

# RPCアダプター

OpenClawはJSON-RPCを介して外部CLIと連携します。現在、2つのパターンが使用されています。

## パターンA：HTTPデーモン（signal-cli）

- `signal-cli`はHTTP上のJSON-RPCを持つデーモンとして動作します。
- イベントストリームはSSE（`/api/v1/events`）です。
- ヘルスプローブ：`/api/v1/check`。
- `channels.signal.autoStart=true`の場合、OpenClawがライフサイクルを管理します。

セットアップとエンドポイントについては、[Signal](/channels/signal)を参照してください。

## パターンB：stdio子プロセス（レガシー：imsg）

> **注意：** 新しいiMessageセットアップの場合は、代わりに[BlueBubbles](/channels/bluebubbles)を使用してください。

- OpenClawは`imsg rpc`を子プロセスとして起動します（レガシーiMessage連携）。
- JSON-RPCはstdin/stdout上の行区切り形式です（1行につき1つのJSONオブジェクト）。
- TCPポートもデーモンも不要です。

使用されるコアメソッド：

- `watch.subscribe` → 通知（`method: "message"`）
- `watch.unsubscribe`
- `send`
- `chats.list`（プローブ/診断）

レガシーセットアップとアドレス指定（`chat_id`推奨）については、[iMessage](/channels/imessage)を参照してください。

## アダプターガイドライン

- Gateway ゲートウェイがプロセスを管理します（開始/停止はプロバイダーのライフサイクルに紐づきます）。
- RPCクライアントを耐障害性のあるものに保ちましょう：タイムアウト、終了時の再起動。
- 表示文字列よりも安定したID（例：`chat_id`）を優先してください。
