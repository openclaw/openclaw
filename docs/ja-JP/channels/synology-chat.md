---
read_when:
    - Synology Chat を OpenClaw でセットアップする
    - Synology Chat の Webhook ルーティングをデバッグする
summary: Synology Chat の Webhook セットアップと OpenClaw 設定
title: Synology Chat
x-i18n:
    generated_at: "2026-04-02T08:53:32Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 05a4519c6dfd703d554aa3518258e9fca0b9fe4320bd9c299f96691d15a01c52
    source_path: channels/synology-chat.md
    workflow: 15
---

# Synology Chat（プラグイン）

ステータス: Synology Chat Webhook を使用したダイレクトメッセージチャネルとしてプラグイン経由でサポートされています。
このプラグインは Synology Chat の送信 Webhook からの受信メッセージを受け取り、
Synology Chat の受信 Webhook を通じて返信を送信します。

## プラグインが必要です

Synology Chat はプラグインベースであり、デフォルトのコアチャネルインストールには含まれていません。

ローカルチェックアウトからインストール:

```bash
openclaw plugins install ./path/to/local/synology-chat-plugin
```

詳細: [プラグイン](/tools/plugin)

## クイックセットアップ

1. Synology Chat プラグインをインストールして有効にします。
   - `openclaw onboard` で、`openclaw channels add` と同じチャネルセットアップリストに Synology Chat が表示されるようになりました。
   - 非対話型セットアップ: `openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
2. Synology Chat のインテグレーション設定:
   - 受信 Webhook を作成し、その URL をコピーします。
   - シークレットトークンを使用して送信 Webhook を作成します。
3. 送信 Webhook の URL を OpenClaw Gateway ゲートウェイに設定します:
   - デフォルトでは `https://gateway-host/webhook/synology`。
   - またはカスタムの `channels.synology-chat.webhookPath`。
4. OpenClaw でセットアップを完了します。
   - ガイド付き: `openclaw onboard`
   - 直接: `openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
5. Gateway ゲートウェイを再起動し、Synology Chat ボットにダイレクトメッセージを送信します。

最小構成:

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      token: "synology-outgoing-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...",
      webhookPath: "/webhook/synology",
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
      rateLimitPerMinute: 30,
      allowInsecureSsl: false,
    },
  },
}
```

## 環境変数

デフォルトアカウントでは、環境変数を使用できます:

- `SYNOLOGY_CHAT_TOKEN`
- `SYNOLOGY_CHAT_INCOMING_URL`
- `SYNOLOGY_NAS_HOST`
- `SYNOLOGY_ALLOWED_USER_IDS`（カンマ区切り）
- `SYNOLOGY_RATE_LIMIT`
- `OPENCLAW_BOT_NAME`

設定値は環境変数よりも優先されます。

## ダイレクトメッセージポリシーとアクセス制御

- `dmPolicy: "allowlist"` が推奨デフォルトです。
- `allowedUserIds` は Synology ユーザー ID のリスト（またはカンマ区切り文字列）を受け付けます。
- `allowlist` モードでは、`allowedUserIds` リストが空の場合は設定ミスとして扱われ、Webhook ルートは起動しません（すべて許可するには `dmPolicy: "open"` を使用してください）。
- `dmPolicy: "open"` はすべての送信者を許可します。
- `dmPolicy: "disabled"` はダイレクトメッセージをブロックします。
- 返信先の紐付けはデフォルトで安定した数値の `user_id` に基づきます。`channels.synology-chat.dangerouslyAllowNameMatching: true` は、返信配信のために変更可能なユーザー名/ニックネーム検索を再有効化する緊急用互換モードです。
- ペアリング承認は以下で動作します:
  - `openclaw pairing list synology-chat`
  - `openclaw pairing approve synology-chat <CODE>`

## 送信配信

数値の Synology Chat ユーザー ID をターゲットとして使用します。

例:

```bash
openclaw message send --channel synology-chat --target 123456 --text "Hello from OpenClaw"
openclaw message send --channel synology-chat --target synology-chat:123456 --text "Hello again"
```

メディア送信は URL ベースのファイル配信でサポートされています。

## マルチアカウント

複数の Synology Chat アカウントが `channels.synology-chat.accounts` でサポートされています。
各アカウントはトークン、受信 URL、Webhook パス、ダイレクトメッセージポリシー、および制限をオーバーライドできます。
ダイレクトメッセージセッションはアカウントおよびユーザーごとに分離されるため、2つの異なる Synology アカウントで同じ数値の `user_id` がトランスクリプト状態を共有することはありません。
有効な各アカウントには個別の `webhookPath` を設定してください。OpenClaw は重複する完全一致パスを拒否し、マルチアカウントセットアップで共有 Webhook パスのみを継承する名前付きアカウントの起動を拒否するようになりました。
名前付きアカウントでレガシー継承を意図的に必要とする場合は、そのアカウントまたは `channels.synology-chat` に `dangerouslyAllowInheritedWebhookPath: true` を設定してください。ただし、重複する完全一致パスはフェイルクローズで拒否されます。明示的なアカウントごとのパスを推奨します。

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      accounts: {
        default: {
          token: "token-a",
          incomingUrl: "https://nas-a.example.com/...token=...",
        },
        alerts: {
          token: "token-b",
          incomingUrl: "https://nas-b.example.com/...token=...",
          webhookPath: "/webhook/synology-alerts",
          dmPolicy: "allowlist",
          allowedUserIds: ["987654"],
        },
      },
    },
  },
}
```

## セキュリティに関する注意事項

- `token` は秘密に保ち、漏洩した場合はローテーションしてください。
- 自己署名のローカル NAS 証明書を明示的に信頼する場合を除き、`allowInsecureSsl: false` のままにしてください。
- 受信 Webhook リクエストはトークン検証およびレートリミットが送信者ごとに適用されます。
- 本番環境では `dmPolicy: "allowlist"` を推奨します。
- レガシーのユーザー名ベースの返信配信が明示的に必要な場合を除き、`dangerouslyAllowNameMatching` はオフのままにしてください。
- マルチアカウントセットアップで共有パスルーティングのリスクを明示的に受け入れる場合を除き、`dangerouslyAllowInheritedWebhookPath` はオフのままにしてください。

## 関連ドキュメント

- [チャネル概要](/channels) — サポートされているすべてのチャネル
- [ペアリング](/channels/pairing) — ダイレクトメッセージの認証とペアリングフロー
- [グループ](/channels/groups) — グループチャットの動作とメンションゲーティング
- [チャネルルーティング](/channels/channel-routing) — メッセージのセッションルーティング
- [セキュリティ](/gateway/security) — アクセスモデルとハードニング
