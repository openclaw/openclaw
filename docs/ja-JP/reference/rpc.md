---
summary: "外部 CLI（signal-cli、レガシー imsg）の RPC アダプターと Gateway パターン"
read_when:
  - 外部 CLI インテグレーションを追加または変更するとき
  - RPC アダプター（signal-cli、imsg）をデバッグするとき
title: "RPC アダプター"
---

# RPC アダプター

OpenClaw は JSON-RPC を通じて外部 CLI を統合します。現在 2 つのパターンが使用されています。

## パターン A: HTTP デーモン（signal-cli）

- `signal-cli` は HTTP 上の JSON-RPC でデーモンとして実行されます。
- イベントストリームは SSE（`/api/v1/events`）です。
- ヘルスプローブ: `/api/v1/check`。
- `channels.signal.autoStart=true` の場合、OpenClaw がライフサイクルを管理します。

セットアップとエンドポイントについては [Signal](/channels/signal) を参照してください。

## パターン B: stdio 子プロセス（レガシー: imsg）

> **注意:** 新しい iMessage のセットアップには、代わりに [BlueBubbles](/channels/bluebubbles) を使用してください。

- OpenClaw は `imsg rpc` を子プロセスとして生成します（レガシーの iMessage インテグレーション）。
- JSON-RPC は stdin/stdout 経由の行区切りです（1 行につき 1 つの JSON オブジェクト）。
- TCP ポートもデーモンも必要ありません。

使用されるコアメソッド:

- `watch.subscribe` → 通知（`method: "message"`）
- `watch.unsubscribe`
- `send`
- `chats.list`（プローブ/診断）

レガシーのセットアップとアドレッシング（`chat_id` を推奨）については [iMessage](/channels/imessage) を参照してください。

## アダプターのガイドライン

- Gateway がプロセスを管理します（開始/停止はプロバイダーのライフサイクルに紐づいています）。
- RPC クライアントを耐障害性のある設計にしてください: タイムアウト、終了時の再起動。
- 表示文字列よりも安定した ID（例: `chat_id`）を優先してください。
