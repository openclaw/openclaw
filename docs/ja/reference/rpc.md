---
summary: "外部 CLI（signal-cli、レガシーの imsg）向けの RPC アダプターとゲートウェイのパターン"
read_when:
  - 外部 CLI 連携の追加または変更時
  - RPC アダプター（signal-cli、imsg）のデバッグ時
title: "RPC アダプター"
---

# RPC アダプター

OpenClaw は JSON-RPC を介して外部 CLI を統合します。現在は 2 つのパターンが使用されています。 現在では二つの模様が用いられている。

## パターン A: HTTP デーモン（signal-cli）

- `signal-cli` は、HTTP 上の JSON-RPC を提供するデーモンとして実行されます。
- イベントストリームは SSE（`/api/v1/events`）です。
- ヘルスプローブ: `/api/v1/check`。
- `channels.signal.autoStart=true` の場合、OpenClaw がライフサイクルを管理します。

セットアップとエンドポイントについては [Signal](/channels/signal) を参照してください。

## パターン B: stdio 子プロセス（レガシー: imsg）

> **注記:** 新規の iMessage セットアップでは、代わりに [BlueBubbles](/channels/bluebubbles) を使用してください。

- OpenClaw は `imsg rpc` を子プロセスとして起動します（レガシーの iMessage 連携）。
- JSON-RPC は stdin/stdout 上で行区切り（1 行につき 1 つの JSON オブジェクト）で通信します。
- TCP ポートは不要で、デーモンも必要ありません。

使用される主要メソッド:

- `watch.subscribe` → 通知（`method: "message"`）
- `watch.unsubscribe`
- `send`
- `chats.list`（プローブ／診断）

レガシーのセットアップおよびアドレッシング（`chat_id` を推奨）については [iMessage](/channels/imessage) を参照してください。

## アダプターのガイドライン

- Gateway（ゲートウェイ）がプロセスを所有します（開始／停止はプロバイダーのライフサイクルに連動）。
- RPC クライアントは堅牢にしてください: タイムアウト、終了時の再起動。
- 表示文字列よりも安定した ID（例: `chat_id`）を優先してください。
