---
summary: "GatewayからOpenAI互換の/v1/chat/completions HTTPエンドポイントを公開"
read_when:
  - Integrating tools that expect OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions（HTTP）

OpenClawのGatewayは小規模なOpenAI互換Chat Completionsエンドポイントを提供できます。

このエンドポイントは**デフォルトで無効**です。最初に設定で有効にしてください。

- `POST /v1/chat/completions`
- Gatewayと同じポート（WS + HTTP多重化）：`http://<gateway-host>:<port>/v1/chat/completions`

内部的にはリクエストは通常のGatewayエージェント実行として処理されます（`openclaw agent`と同じコードパス）。ルーティング/権限/設定はGatewayと一致します。

## 認証

Gateway認証設定を使用します。Bearerトークンを送信してください：

- `Authorization: Bearer <token>`

注意：

- `gateway.auth.mode="token"`の場合、`gateway.auth.token`（または`OPENCLAW_GATEWAY_TOKEN`）を使用します。
- `gateway.auth.mode="password"`の場合、`gateway.auth.password`（または`OPENCLAW_GATEWAY_PASSWORD`）を使用します。
- `gateway.auth.rateLimit`が設定されていて認証失敗が多すぎる場合、エンドポイントは`Retry-After`付きの`429`を返します。

## エージェントの選択

カスタムヘッダーは不要です。OpenAIの`model`フィールドにエージェントIDをエンコードします：

- `model: "openclaw:<agentId>"`（例：`"openclaw:main"`、`"openclaw:beta"`）
- `model: "agent:<agentId>"`（エイリアス）

またはヘッダーで特定のOpenClawエージェントを指定します：

- `x-openclaw-agent-id: <agentId>`（デフォルト：`main`）

上級者向け：

- `x-openclaw-session-key: <sessionKey>` セッションルーティングを完全に制御します。

## エンドポイントの有効化

`gateway.http.endpoints.chatCompletions.enabled`を`true`に設定します：

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

`gateway.http.endpoints.chatCompletions.enabled`を`false`に設定します：

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

## セッション動作

デフォルトではエンドポイントは**リクエストごとにステートレス**です（各呼び出しで新しいセッションキーが生成されます）。

リクエストにOpenAIの`user`文字列が含まれている場合、Gatewayはそこから安定したセッションキーを導出するため、繰り返しの呼び出しでエージェントセッションを共有できます。

## ストリーミング（SSE）

`stream: true`を設定するとServer-Sent Events（SSE）を受信します：

- `Content-Type: text/event-stream`
- 各イベント行は`data: <json>`
- ストリームは`data: [DONE]`で終了

## 例

ノンストリーミング：

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

ストリーミング：

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
