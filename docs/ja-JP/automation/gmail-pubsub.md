---
summary: "gogcli 経由で Gmail Pub/Sub プッシュを OpenClaw Webhook に接続する"
read_when:
  - Gmail 受信トレイトリガーを OpenClaw に接続するとき
  - エージェントウェイク用の Pub/Sub プッシュを設定するとき
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

目標: Gmail ウォッチ -> Pub/Sub プッシュ -> `gog gmail watch serve` -> OpenClaw Webhook。

## 前提条件

- `gcloud` がインストールされてログイン済み（[インストールガイド](https://docs.cloud.google.com/sdk/docs/install-sdk)）。
- `gog`（gogcli）がインストールされて Gmail アカウントで認証済み（[gogcli.sh](https://gogcli.sh/)）。
- OpenClaw フックが有効（[Webhook](/automation/webhook) 参照）。
- `tailscale` がログイン済み（[tailscale.com](https://tailscale.com/)）。サポートされている設定では、公開 HTTPS エンドポイントに Tailscale Funnel を使用します。他のトンネルサービスも動作しますが、DIY/非サポートで手動での配線が必要です。現時点では Tailscale がサポート対象です。

フック設定例（Gmail プリセットマッピングを有効にする）:

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

Gmail サマリーをチャットサーフェスに配信するには、`deliver` + オプションの `channel`/`to` を設定したマッピングでプリセットをオーバーライドします:

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

固定チャンネルが必要な場合は `channel` + `to` を設定してください。それ以外の場合、`channel: "last"` は最後のデリバリールートを使用します（WhatsApp にフォールバック）。

Gmail の実行に安価なモデルを強制するには、マッピングで `model` を設定してください（`provider/model` またはエイリアス）。`agents.defaults.models` を適用している場合は、そこにも含めてください。

Gmail フック専用のデフォルトモデルとシンキングレベルを設定するには、設定に `hooks.gmail.model` / `hooks.gmail.thinking` を追加します:

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

注意:

- マッピングのフックごとの `model`/`thinking` はこれらのデフォルトより優先されます。
- フォールバック順序: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → プライマリ（認証/レート制限/タイムアウト）。
- `agents.defaults.models` が設定されている場合、Gmail モデルは許可リストに含まれている必要があります。
- Gmail フックのコンテンツはデフォルトで外部コンテンツの安全境界でラップされます。無効にするには（危険）、`hooks.gmail.allowUnsafeExternalContent: true` を設定してください。

ペイロード処理をさらにカスタマイズするには、`hooks.mappings` を追加するか、`~/.openclaw/hooks/transforms` 以下に JS/TS トランスフォームモジュールを配置してください（[Webhook](/automation/webhook) 参照）。

## ウィザード（推奨）

OpenClaw ヘルパーを使用してすべてを一緒に配線します（macOS では brew 経由で依存関係をインストール）:

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

デフォルト:

- 公開プッシュエンドポイントに Tailscale Funnel を使用します。
- `openclaw webhooks gmail run` 用の `hooks.gmail` 設定を書き込みます。
- Gmail フックプリセットを有効にします（`hooks.presets: ["gmail"]`）。

パスの注意: `tailscale.mode` が有効な場合、OpenClaw は自動的に `hooks.gmail.serve.path` を `/` に設定し、公開パスを `hooks.gmail.tailscale.path`（デフォルト `/gmail-pubsub`）に維持します。Tailscale はプロキシ前に設定されたパスプレフィックスを取り除くためです。バックエンドがプレフィックス付きパスを受け取る必要がある場合は、`hooks.gmail.tailscale.target`（または `--tailscale-target`）を `http://127.0.0.1:8788/gmail-pubsub` のような完全な URL に設定し、`hooks.gmail.serve.path` と一致させてください。

カスタムエンドポイントが必要な場合は `--push-endpoint <url>` または `--tailscale off` を使用してください。

プラットフォームの注意: macOS では、ウィザードは Homebrew 経由で `gcloud`、`gogcli`、`tailscale` をインストールします。Linux では先にこれらを手動でインストールしてください。

Gateway の自動起動（推奨）:

- `hooks.enabled=true` かつ `hooks.gmail.account` が設定されている場合、Gateway は起動時に `gog gmail watch serve` を開始し、ウォッチを自動更新します。
- オプトアウトするには `OPENCLAW_SKIP_GMAIL_WATCHER=1` を設定してください（デーモンを自分で実行する場合に便利）。
- 手動デーモンを同時に実行しないでください。`listen tcp 127.0.0.1:8788: bind: address already in use` エラーが発生します。

手動デーモン（`gog gmail watch serve` + 自動更新を起動）:

```bash
openclaw webhooks gmail run
```

## 初回セットアップ

1. `gog` が使用する OAuth クライアントを所有する GCP プロジェクトを選択します。

```bash
gcloud auth login
gcloud config set project <project-id>
```

注意: Gmail ウォッチには、Pub/Sub トピックが OAuth クライアントと同じプロジェクトに存在する必要があります。

2. API を有効にします:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. トピックを作成します:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Gmail プッシュにパブリッシュを許可します:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## ウォッチを開始する

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

出力から `history_id` を保存しておいてください（デバッグ用）。

## プッシュハンドラーを実行する

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

注意:

- `--token` はプッシュエンドポイントを保護します（`x-gog-token` または `?token=`）。
- `--hook-url` は OpenClaw の `/hooks/gmail` を指定します（マップ済み; アイソレーテッド実行 + メインへのサマリー）。
- `--include-body` と `--max-bytes` は OpenClaw に送信されるボディスニペットを制御します。

推奨: `openclaw webhooks gmail run` は同じフローをラップして、ウォッチを自動更新します。

## ハンドラーを公開する（上級者向け、非サポート）

Tailscale 以外のトンネルが必要な場合は、手動で配線してプッシュサブスクリプションで公開 URL を使用します（非サポート、ガードレールなし）:

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

生成された URL をプッシュエンドポイントとして使用します:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

本番環境: 安定した HTTPS エンドポイントを使用し、Pub/Sub OIDC JWT を設定して実行します:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## テスト

ウォッチされている受信トレイにメッセージを送信します:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

ウォッチの状態と履歴を確認します:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## トラブルシューティング

- `Invalid topicName`: プロジェクトの不一致（トピックが OAuth クライアントプロジェクトにない）。
- `User not authorized`: トピックに `roles/pubsub.publisher` が不足している。
- 空のメッセージ: Gmail プッシュは `historyId` のみ提供します。`gog gmail history` で取得してください。

## クリーンアップ

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
