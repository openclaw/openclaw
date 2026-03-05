---
summary: "外部CLI（signal-cli、レガシーimsg）向けのRPCアダプターとゲートウェイパターン"
read_when:
  - 外部CLIの統合を追加または変更する場合
  - RPCアダプター（signal-cli、imsg）のデバッグ
title: "RPC Adapters"
x-i18n:
  source_path: "docs/reference/rpc.md"
  generated_at: "2026-03-05T10:01:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
---

# RPCアダプター

OpenClawはJSON-RPCを介して外部CLIと連携します。現在、2つのパターンが使用されています。

## パターンA: HTTPデーモン（signal-cli）

- `signal-cli`はJSON-RPC over HTTPのデーモンとして動作します。
- イベントストリームはSSE（`/api/v1/events`）です。
- ヘルスプローブ：`/api/v1/check`。
- `channels.signal.autoStart=true`の場合、OpenClawがライフサイクルを管理します。

セットアップとエンドポイントの詳細は[Signal](/channels/signal)を参照してください。

## パターンB: stdio子プロセス（レガシー: imsg）

> **注意:** 新しいiMessageのセットアップには、代わりに[BlueBubbles](/channels/bluebubbles)を使用してください。

- OpenClawは`imsg rpc`を子プロセスとして起動します（レガシーiMessage連携）。
- JSON-RPCはstdin/stdout上の行区切り形式です（1行に1つのJSONオブジェクト）。
- TCPポートもデーモンも不要です。

使用されるコアメソッド：

- `watch.subscribe` → 通知（`method: "message"`）
- `watch.unsubscribe`
- `send`
- `chats.list`（プローブ/診断）

レガシーセットアップとアドレッシング（`chat_id`推奨）については[iMessage](/channels/imessage)を参照してください。

## アダプターガイドライン

- ゲートウェイがプロセスを管理します（開始/停止はプロバイダーのライフサイクルに連動）。
- RPCクライアントは回復力を持たせてください：タイムアウト、終了時の再起動。
- 表示文字列よりも安定したID（例：`chat_id`）を優先してください。
