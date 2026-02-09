---
summary: "Gateway HTTP エンドポイント経由で単一のツールを直接呼び出します"
read_when:
  - フルエージェントのターンを実行せずにツールを呼び出す場合
  - ツールポリシーの適用が必要な自動化を構築する場合
title: "Tools Invoke API"
---

# Tools Invoke（HTTP）

OpenClaw の Gateway は、単一のツールを直接呼び出すためのシンプルな HTTP エンドポイントを公開しています。これは常に有効ですが、Gateway の認証およびツールポリシーによって制御されます。 常に有効になっていますが、Gatewayの認証とツールポリシーに基づいています。

- `POST /tools/invoke`
- Gateway と同じポート（WS + HTTP の多重化）：`http://<gateway-host>:<port>/tools/invoke`

デフォルトの最大ペイロードサイズは 2 MB です。

## 認証

ゲートウェイ認証設定を使用します。 ベアラートトークンを送信:

- `Authorization: Bearer <token>`

注記:

- `gateway.auth.mode="token"` の場合は、`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）を使用します。
- `gateway.auth.mode="password"` の場合は、`gateway.auth.password`（または `OPENCLAW_GATEWAY_PASSWORD`）を使用します。

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

フィールド:

- `tool`（string、必須）: 呼び出すツール名。
- `action`（string、任意）: ツールスキーマが `action` をサポートし、args ペイロードで省略された場合に args にマッピングされます。
- `args`（object、任意）: ツール固有の引数。
- `sessionKey` (string, optional): ターゲットセッションキー。 `sessionKey`（string、任意）: 対象のセッションキー。省略された場合、または `"main"` の場合、Gateway は設定されたメインのセッションキーを使用します（`session.mainKey` およびデフォルトエージェントを尊重するか、グローバルスコープでは `global` を使用します）。
- `dryRun`（boolean、任意）: 将来使用のために予約されています。現在は無視されます。

## ポリシー + ルーティングの挙動

ツールの可用性は、Gateway エージェントで使用されるのと同じポリシーチェーンを通じてフィルタリングされます。

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- グループポリシー（セッションキーがグループまたはチャンネルにマッピングされている場合）
- サブエージェントポリシー（サブエージェントのセッションキーで呼び出す場合）

ツールがポリシーで許可されていない場合、エンドポイントは **404** を返します。

グループポリシーがコンテキストを解決しやすくするために、任意で次を設定できます。

- `x-openclaw-message-channel: <channel>`（例: `slack`, `telegram`）
- `x-openclaw-account-id: <accountId>`（複数のアカウントが存在する場合）

## レスポンス

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }`（無効なリクエストまたはツールエラー）
- `401` → 未認証
- `404` → ツールが利用不可（未検出、または許可リストに含まれていない）
- `405` → メソッドが許可されていません

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
