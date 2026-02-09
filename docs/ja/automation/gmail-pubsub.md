---
summary: "gogcli を介して OpenClaw Webhook に接続された Gmail Pub/Sub プッシュ"
read_when:
  - Gmail の受信トリガーを OpenClaw に接続する
  - エージェント起動のために Pub/Sub プッシュを設定する
title: "Gmail Pub/Sub"
---

# Gmail Pub/Sub -> OpenClaw

目標: Gmail watch -> Pub/Sub プッシュ -> `gog gmail watch serve` -> OpenClaw Webhook。

## Prereq

- `gcloud` がインストールされ、ログイン済みであること（[インストールガイド](https://docs.cloud.google.com/sdk/docs/install-sdk)）。
- `gog`（gogcli）がインストールされ、Gmail アカウントに対して認可済みであること（[gogcli.sh](https://gogcli.sh/)）。
- OpenClaw のフックが有効になっていること（[Webhooks](/automation/webhook) を参照）。
- `tailscale` logged in ([tailscale.com](https://tailscale.com/)). サポートされているセットアップでは、パブリック HTTPS エンドポイントの Tailscale Funnel が使用されます。
  他のトンネルサービスは機能しますが、DIY/サポートされておらず、手動配線が必要です。
  現在、私たちが支援しているのは、大規模なものです。

フック設定の例（Gmail プリセットマッピングを有効化）:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

Gmail のサマリーをチャットサーフェスに配信するには、`deliver` と、任意で `channel`/`to` を設定するマッピングでプリセットを上書きします。

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

固定されたチャンネルが欲しい場合は、 `channel` + `to` を設定します。 固定チャンネルにしたい場合は、`channel` と `to` を設定します。そうでない場合、`channel: "last"` は直近の配信ルートを使用します（WhatsApp にフォールバックします）。

Gmail 実行時により安価なモデルを強制するには、マッピング内で `model` を設定します（`provider/model` またはエイリアス）。`agents.defaults.models` を強制する場合は、そこに含めてください。 `agents.defaults.models` を強制する場合は、そこに含めます。

Gmail フック専用のデフォルトモデルと思考レベルを設定するには、設定に `hooks.gmail.model` / `hooks.gmail.thinking` を追加します。

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

注記:

- マッピング内のフック単位の `model`/`thinking` は、これらのデフォルトを引き続き上書きします。
- フォールバック順序: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → プライマリ（認証／レート制限／タイムアウト）。
- `agents.defaults.models` が設定されている場合、Gmail モデルは許可リストに含まれている必要があります。
- Gmail フックのコンテンツは、デフォルトで外部コンテンツの安全境界でラップされます。
  無効化するには（危険）、`hooks.gmail.allowUnsafeExternalContent: true` を設定してください。
  無効にするには、 `hooks.gmail.allowUnsafeExternalContent: true` を設定します。

ペイロード処理をさらにカスタマイズするには、`hooks.mappings` を追加するか、`hooks.transformsDir` 配下に JS/TS の変換モジュールを追加します（[Webhooks](/automation/webhook) を参照）。

## ウィザード（推奨）

OpenClaw ヘルパーを使用して、すべてをまとめて配線します（macOS では brew 経由で依存関係をインストールします）。

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

デフォルト:

- 公開プッシュエンドポイントに Tailscale Funnel を使用します。
- `openclaw webhooks gmail run` 向けに `hooks.gmail` 設定を書き込みます。
- Gmail フックのプリセット（`hooks.presets: ["gmail"]`）を有効化します。

パスに関する注意: `tailscale.mode` が有効な場合、OpenClaw は自動的に
`hooks.gmail.serve.path` を `/` に設定し、公開パスを
`hooks.gmail.tailscale.path`（デフォルト `/gmail-pubsub`）に保持します。これは Tailscale が
プロキシ時に set-path のプレフィックスを削除するためです。
バックエンドでプレフィックス付きパスを受信する必要がある場合は、
`hooks.gmail.tailscale.target`（または `--tailscale-target`）を
`http://127.0.0.1:8788/gmail-pubsub` のような完全な URL に設定し、`hooks.gmail.serve.path` を一致させてください。
接頭辞付きパスを受け取るためにバックエンドが必要な場合は、
`hooks.gmail.tailscale.target` (または `--tailscale-target` ) に
`http://127.0.0.1:8788/gmail-pubsub` のような完全な URL を設定し、`hooks.gmail.serve.path` と一致します。

カスタムエンドポイントをご希望ですか？ カスタムエンドポイントを使用したい場合は、`--push-endpoint <url>` または `--tailscale off` を使用してください。

プラットフォームに関する注意: macOS では、ウィザードが Homebrew 経由で `gcloud`、`gogcli`、`tailscale` をインストールします。
Linux では、事前に手動でインストールしてください。

Gateway の自動起動（推奨）:

- `hooks.enabled=true` と `hooks.gmail.account` が設定されている場合、Gateway は
  起動時に `gog gmail watch serve` を開始し、watch を自動更新します。
- オプトアウトするには `OPENCLAW_SKIP_GMAIL_WATCHER=1` を設定します（デーモンを自分で実行する場合に有用です）。
- 手動デーモンを同時に実行しないでください。`listen tcp 127.0.0.1:8788: bind: address already in use` が発生します。

手動デーモン（`gog gmail watch serve` を開始 + 自動更新）:

```bash
openclaw webhooks gmail run
```

## 初回セットアップ

1. `gog` が使用する **OAuth クライアントを所有する** GCP プロジェクトを選択します。

```bash
gcloud auth login
gcloud config set project <project-id>
```

注記: Gmail watch では、Pub/Sub トピックは OAuth クライアントと同じプロジェクトに存在する必要があります。

2. API を有効化します。

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. トピックを作成します。

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Gmail プッシュの公開を許可します。

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## watch を開始

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

出力から `history_id` を保存してください（デバッグ用）。

## プッシュハンドラーを実行

ローカル例（共有トークン認証）:

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

注記:

- `--token` はプッシュエンドポイント（`x-gog-token` または `?token=`）を保護します。
- `--hook-url` は OpenClaw の `/hooks/gmail` を指します（マッピング済み；分離実行 + メインへのサマリー）。
- `--include-body` と `--max-bytes` は、OpenClaw に送信される本文スニペットを制御します。

推奨: `openclaw webhooks gmail run` は同じフローをラップし、watch を自動更新します。

## ハンドラーを公開（高度、非サポート）

Tailscale 以外のトンネルが必要な場合は、手動で配線し、プッシュサブスクリプションに公開 URL を使用してください（非サポート、ガードレールなし）。

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

生成された URL をプッシュエンドポイントとして使用します。

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

本番環境: 安定した HTTPS エンドポイントを使用し、Pub/Sub OIDC JWT を設定してから、次を実行します。

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## テスト

ウォッチした受信トレイにメッセージを送信:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

watch の状態と履歴を確認します。

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## トラブルシューティング

- `Invalid topicName`: プロジェクトの不一致（トピックが OAuth クライアントのプロジェクトにありません）。
- `User not authorized`: トピックに `roles/pubsub.publisher` がありません。
- 空のメッセージ: Gmail プッシュは `historyId` のみを提供します。`gog gmail history` 経由で取得してください。

## クリーンアップ

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
