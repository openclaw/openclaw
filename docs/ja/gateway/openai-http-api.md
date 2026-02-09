---
summary: "Gateway（ゲートウェイ）から OpenAI 互換の /v1/chat/completions HTTP エンドポイントを公開します"
read_when:
  - OpenAI Chat Completions を想定するツールを統合する場合
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions（HTTP）

OpenClaw の Gateway（ゲートウェイ）は、小規模な OpenAI 互換の Chat Completions エンドポイントを提供できます。

このエンドポイントは **デフォルトでは無効** です。まず設定で有効化してください。 最初に設定で有効にします。

- `POST /v1/chat/completions`
- Gateway（ゲートウェイ）と同一ポート（WS + HTTP の多重化）：`http://<gateway-host>:<port>/v1/chat/completions`

内部的には、リクエストは通常の Gateway エージェント実行として処理されます（`openclaw agent` と同一のコードパス）。そのため、ルーティング／権限／設定は Gateway と一致します。

## 認証

ゲートウェイ認証設定を使用します。 ベアラートトークンを送信:

- `Authorization: Bearer <token>`

注記:

- `gateway.auth.mode="token"` の場合は、`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）を使用します。
- `gateway.auth.mode="password"` の場合は、`gateway.auth.password`（または `OPENCLAW_GATEWAY_PASSWORD`）を使用します。

## エージェントの選択

カスタムヘッダーは不要です。OpenAI の `model` フィールドにエージェント ID をエンコードします。

- `model: "openclaw:<agentId>"`（例: `"openclaw:main"`、`"openclaw:beta"`）
- `model: "agent:<agentId>"`（エイリアス）

または、ヘッダーで特定の OpenClaw エージェントを指定できます。

- `x-openclaw-agent-id: <agentId>`（デフォルト: `main`）

高度な設定:

- セッションルーティングを完全に制御するには `x-openclaw-session-key: <sessionKey>` を使用します。

## エンドポイントの有効化

`gateway.http.endpoints.chatCompletions.enabled` を `true` に設定します。

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## エンドポイントの無効化

`gateway.http.endpoints.chatCompletions.enabled` を `false` に設定します。

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## セッションの挙動

デフォルトでは、このエンドポイントは **リクエストごとにステートレス** です（呼び出しごとに新しいセッションキーが生成されます）。

リクエストに OpenAI の `user` 文字列が含まれる場合、Gateway はそこから安定したセッションキーを導出するため、繰り返しの呼び出しでエージェントセッションを共有できます。

## ストリーミング（SSE）

Server-Sent Events（SSE）を受信するには `stream: true` を設定します。

- `Content-Type: text/event-stream`
- 各イベント行は `data: <json>`
- ストリームは `data: [DONE]` で終了します。

## 例

非ストリーミング:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

ストリーミング:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
