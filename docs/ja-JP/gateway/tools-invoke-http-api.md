---
summary: "Gateway HTTPエンドポイント経由で単一ツールを直接呼び出し"
read_when:
  - Calling tools without running a full agent turn
  - Building automations that need tool policy enforcement
title: "Tools Invoke API"
---

# Tools Invoke（HTTP）

OpenClawのGatewayは単一ツールを直接呼び出すためのシンプルなHTTPエンドポイントを公開します。常に有効ですが、Gateway認証とツールポリシーによってゲートされます。

- `POST /tools/invoke`
- Gatewayと同じポート（WS + HTTP多重化）：`http://<gateway-host>:<port>/tools/invoke`

デフォルトの最大ペイロードサイズは2 MBです。

## 認証

Gateway認証設定を使用します。Bearerトークンを送信してください：

- `Authorization: Bearer <token>`

注意：

- `gateway.auth.mode="token"`の場合、`gateway.auth.token`（または`OPENCLAW_GATEWAY_TOKEN`）を使用します。
- `gateway.auth.mode="password"`の場合、`gateway.auth.password`（または`OPENCLAW_GATEWAY_PASSWORD`）を使用します。
- `gateway.auth.rateLimit`が設定されていて認証失敗が多すぎる場合、エンドポイントは`Retry-After`付きの`429`を返します。

## リクエストボディ

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

フィールド：

- `tool`（文字列、必須）：呼び出すツール名。
- `action`（文字列、オプション）：ツールスキーマが`action`をサポートし、argsペイロードがそれを省略した場合にargsにマッピングされます。
- `args`（オブジェクト、オプション）：ツール固有の引数。
- `sessionKey`（文字列、オプション）：ターゲットセッションキー。省略または`"main"`の場合、Gatewayは設定されたメインセッションキーを使用します（`session.mainKey`とデフォルトエージェントを尊重、またはグローバルスコープでは`global`）。
- `dryRun`（ブール、オプション）：将来の使用のために予約。現在は無視されます。

## ポリシー + ルーティング動作

ツールの利用可能性はGatewayエージェントが使用するのと同じポリシーチェーンでフィルタリングされます：

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- グループポリシー（セッションキーがグループまたはチャンネルにマッピングされる場合）
- サブエージェントポリシー（サブエージェントセッションキーで呼び出す場合）

ツールがポリシーで許可されていない場合、エンドポイントは**404**を返します。

Gateway HTTPはデフォルトでハード拒否リストも適用します（セッションポリシーがツールを許可していても）：

- `sessions_spawn`
- `sessions_send`
- `gateway`
- `whatsapp_login`

この拒否リストは`gateway.tools`でカスタマイズできます：

```json5
{
  gateway: {
    tools: {
      // HTTP /tools/invoke経由でブロックする追加ツール
      deny: ["browser"],
      // デフォルト拒否リストからツールを削除
      allow: ["gateway"],
    },
  },
}
```

グループポリシーがコンテキストを解決するのを助けるため、オプションで設定できます：

- `x-openclaw-message-channel: <channel>`（例：`slack`、`telegram`）
- `x-openclaw-account-id: <accountId>`（複数アカウントが存在する場合）

## レスポンス

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }`（無効なリクエストまたはツール入力エラー）
- `401` → 未認証
- `429` → 認証レート制限（`Retry-After`が設定）
- `404` → ツールが利用不可（見つからないまたは許可リスト外）
- `405` → メソッドが許可されていない
- `500` → `{ ok: false, error: { type, message } }`（予期しないツール実行エラー。サニタイズされたメッセージ）

## 例

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
