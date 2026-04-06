---
read_when:
    - 完全なエージェントターンを実行せずにツールを呼び出す場合
    - ツールポリシーの適用が必要な自動化を構築する場合
summary: Gateway ゲートウェイの HTTP エンドポイント経由で単一のツールを直接呼び出す
title: Tools Invoke API
x-i18n:
    generated_at: "2026-04-02T07:43:30Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 76b1121b868c5ae885a03d56c7f819e1947c158cc9b073897215c2202358e2e6
    source_path: gateway/tools-invoke-http-api.md
    workflow: 15
---

# Tools Invoke (HTTP)

OpenClaw の Gateway ゲートウェイは、単一のツールを直接呼び出すためのシンプルな HTTP エンドポイントを公開しています。このエンドポイントは常に有効で、Gateway ゲートウェイの認証とツールポリシーを使用します。OpenAI 互換の `/v1/*` サーフェスと同様に、共有シークレットのベアラー認証は Gateway ゲートウェイ全体に対する信頼されたオペレーターアクセスとして扱われます。

- `POST /tools/invoke`
- Gateway ゲートウェイと同じポート（WS + HTTP マルチプレクス）: `http://<gateway-host>:<port>/tools/invoke`

デフォルトの最大ペイロードサイズは 2 MB です。

## 認証

Gateway ゲートウェイの認証設定を使用します。ベアラートークンを送信してください：

- `Authorization: Bearer <token>`

注意事項：

- `gateway.auth.mode="token"` の場合、`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）を使用します。
- `gateway.auth.mode="password"` の場合、`gateway.auth.password`（または `OPENCLAW_GATEWAY_PASSWORD`）を使用します。
- `gateway.auth.rateLimit` が設定されていて、認証失敗が多すぎる場合、エンドポイントは `Retry-After` 付きの `429` を返します。

## セキュリティ境界（重要）

このエンドポイントは Gateway ゲートウェイインスタンスに対する**完全なオペレーターアクセス**サーフェスとして扱ってください。

- ここでの HTTP ベアラー認証は、ユーザーごとの狭いスコープモデルではありません。
- このエンドポイント用の有効な Gateway ゲートウェイのトークン/パスワードは、オーナー/オペレーターの資格情報として扱う必要があります。
- 共有シークレット認証モード（`token` および `password`）では、呼び出し元がより狭い `x-openclaw-scopes` ヘッダーを送信しても、エンドポイントは通常の完全なオペレーターデフォルトを復元します。
- 共有シークレット認証は、このエンドポイントでのツール直接呼び出しをオーナー送信者ターンとして扱います。
- 信頼されたアイデンティティベースの HTTP モード（例：信頼されたプロキシ認証や、プライベートイングレスでの `gateway.auth.mode="none"`）は、リクエスト上の宣言されたオペレータースコープを尊重します。
- このエンドポイントは loopback/tailnet/プライベートイングレスのみに配置してください。パブリックインターネットに直接公開しないでください。

認証マトリクス：

- `gateway.auth.mode="token"` または `"password"` + `Authorization: Bearer ...`
  - 共有 Gateway ゲートウェイオペレーターシークレットの所有を証明
  - より狭い `x-openclaw-scopes` を無視
  - 完全なデフォルトオペレータースコープセットを復元
  - このエンドポイントでのツール直接呼び出しをオーナー送信者ターンとして扱う
- 信頼されたアイデンティティベースの HTTP モード（例：信頼されたプロキシ認証、またはプライベートイングレスでの `gateway.auth.mode="none"`）
  - 外部の信頼されたアイデンティティまたはデプロイメント境界を認証
  - 宣言された `x-openclaw-scopes` ヘッダーを尊重
  - 宣言されたスコープに `operator.admin` が実際に含まれている場合のみオーナーセマンティクスを取得

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

- `tool`（string、必須）：呼び出すツール名。
- `action`（string、オプション）：ツールスキーマが `action` をサポートし、args ペイロードで省略されている場合に args にマッピングされます。
- `args`（object、オプション）：ツール固有の引数。
- `sessionKey`（string、オプション）：ターゲットセッションキー。省略または `"main"` の場合、Gateway ゲートウェイは設定されたメインセッションキーを使用します（`session.mainKey` とデフォルトエージェント、またはグローバルスコープでは `global` を尊重します）。
- `dryRun`（boolean、オプション）：将来の使用のために予約済み。現在は無視されます。

## ポリシーとルーティングの動作

ツールの利用可能性は、Gateway ゲートウェイのエージェントが使用するものと同じポリシーチェーンでフィルタリングされます：

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- グループポリシー（セッションキーがグループまたはチャネルにマッピングされる場合）
- サブエージェントポリシー（サブエージェントのセッションキーで呼び出す場合）

ツールがポリシーで許可されていない場合、エンドポイントは **404** を返します。

重要な境界に関する注意事項：

- 実行承認はオペレーターのガードレールであり、この HTTP エンドポイントの個別の認可境界ではありません。ツールが Gateway ゲートウェイ認証 + ツールポリシーを介してここで到達可能な場合、`/tools/invoke` は呼び出しごとの追加の承認プロンプトを追加しません。
- Gateway ゲートウェイのベアラー資格情報を信頼されていない呼び出し元と共有しないでください。信頼境界を跨いで分離が必要な場合は、別々の Gateway ゲートウェイ（理想的には別々の OS ユーザー/ホスト）を実行してください。

Gateway ゲートウェイ HTTP は、セッションポリシーがツールを許可している場合でも、デフォルトでハード拒否リストを適用します：

- `exec` — 直接コマンド実行（RCE サーフェス）
- `spawn` — 任意の子プロセス作成（RCE サーフェス）
- `shell` — シェルコマンド実行（RCE サーフェス）
- `fs_write` — ホスト上の任意のファイル変更
- `fs_delete` — ホスト上の任意のファイル削除
- `fs_move` — ホスト上の任意のファイル移動/リネーム
- `apply_patch` — パッチ適用により任意のファイルを書き換え可能
- `sessions_spawn` — セッションオーケストレーション。リモートでエージェントを生成することは RCE に該当
- `sessions_send` — クロスセッションメッセージインジェクション
- `cron` — 永続的な自動化コントロールプレーン
- `gateway` — Gateway ゲートウェイコントロールプレーン。HTTP 経由の再設定を防止
- `nodes` — ノードコマンドリレーによりペアリングされたホスト上の system.run に到達可能
- `whatsapp_login` — ターミナル QR スキャンが必要なインタラクティブセットアップ。HTTP ではハングする

この拒否リストは `gateway.tools` でカスタマイズできます：

```json5
{
  gateway: {
    tools: {
      // HTTP /tools/invoke でブロックする追加ツール
      deny: ["browser"],
      // デフォルトの拒否リストからツールを削除
      allow: ["gateway"],
    },
  },
}
```

グループポリシーのコンテキスト解決を支援するために、オプションで以下を設定できます：

- `x-openclaw-message-channel: <channel>`（例：`slack`、`telegram`）
- `x-openclaw-account-id: <accountId>`（複数のアカウントが存在する場合）

## レスポンス

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }`（無効なリクエストまたはツール入力エラー）
- `401` → 未認証
- `429` → 認証レート制限（`Retry-After` が設定）
- `404` → ツール利用不可（見つからない、または許可リストに含まれていない）
- `405` → メソッド不許可
- `500` → `{ ok: false, error: { type, message } }`（予期しないツール実行エラー。メッセージはサニタイズ済み）

## 使用例

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer secret' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
