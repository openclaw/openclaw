---
read_when:
    - GmailのInboxトリガーをOpenClawに接続する
    - エージェント起動用のPub/Subプッシュを設定する
summary: gogcliを使ったGmail Pub/SubプッシュとOpenClaw Webhookの連携
title: Gmail PubSub
x-i18n:
    generated_at: "2026-04-02T07:30:19Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 0c8a87516e12091f96209f570012cdba895265af3d48ba848e0260535535bd18
    source_path: automation/gmail-pubsub.md
    workflow: 15
---

# Gmail Pub/Sub -> OpenClaw

目標: Gmail watch -> Pub/Sub プッシュ -> `gog gmail watch serve` -> OpenClaw webhook。

## 前提条件

- `gcloud` がインストールされ、ログイン済みであること（[インストールガイド](https://docs.cloud.google.com/sdk/docs/install-sdk)）。
- `gog`（gogcli）がインストールされ、Gmailアカウントで認証済みであること（[gogcli.sh](https://gogcli.sh/)）。
- OpenClawのhooksが有効であること（[Webhooks](/automation/webhook) を参照）。
- `tailscale` がログイン済みであること（[tailscale.com](https://tailscale.com/)）。サポートされるセットアップでは、パブリックHTTPSエンドポイントにTailscale Funnelを使用します。
  他のトンネルサービスも動作する可能性がありますが、サポート対象外であり、手動での設定が必要です。
  現時点でサポートしているのはTailscaleです。

フック設定の例（Gmail プリセットマッピングを有効にする）:

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

Gmailの要約をチャットサーフェスに配信するには、`deliver` と任意の `channel`/`to` を設定するマッピングでプリセットを上書きします:

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

固定のチャネルを使いたい場合は、`channel` と `to` を設定します。それ以外の場合、`channel: "last"` は最後の配信ルートを使用します（WhatsAppにフォールバックします）。

Gmailの実行でより安価なモデルを強制したい場合は、マッピングで `model` を設定します（`provider/model` またはエイリアス）。`agents.defaults.models` を適用している場合は、そこにも含めてください。

Gmail hooks専用のデフォルトモデルと思考レベルを設定するには、設定に `hooks.gmail.model` / `hooks.gmail.thinking` を追加します:

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

注意事項:

- マッピング内のフックごとの `model`/`thinking` は、これらのデフォルトより優先されます。
- フォールバック順序: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → プライマリ（認証/レート制限/タイムアウト）。
- `agents.defaults.models` が設定されている場合、Gmailのモデルは許可リストに含まれている必要があります。
- Gmailフックのコンテンツは、デフォルトで外部コンテンツの安全境界で囲まれます。
  無効にする場合（危険）は、`hooks.gmail.allowUnsafeExternalContent: true` を設定してください。

ペイロード処理をさらにカスタマイズするには、`hooks.mappings` または `~/.openclaw/hooks/transforms` 配下のJS/TS変換モジュールを追加してください（[Webhooks](/automation/webhook) を参照）。

## ウィザード（推奨）

OpenClawのヘルパーを使用してすべてを接続します（macOSではbrewで依存関係をインストールします）:

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

デフォルト:

- パブリックプッシュエンドポイントにTailscale Funnelを使用します。
- `openclaw webhooks gmail run` 用の `hooks.gmail` 設定を書き込みます。
- Gmailフックプリセットを有効にします（`hooks.presets: ["gmail"]`）。

パスに関する注意: `tailscale.mode` が有効な場合、OpenClawは自動的に `hooks.gmail.serve.path` を `/` に設定し、パブリックパスは `hooks.gmail.tailscale.path`（デフォルト `/gmail-pubsub`）のままにします。これはTailscaleがプロキシ前にset-pathプレフィックスを除去するためです。
バックエンドがプレフィックス付きパスを受け取る必要がある場合は、`hooks.gmail.tailscale.target`（または `--tailscale-target`）を `http://127.0.0.1:8788/gmail-pubsub` のような完全なURLに設定し、`hooks.gmail.serve.path` と一致させてください。

カスタムエンドポイントが必要な場合は、`--push-endpoint <url>` または `--tailscale off` を使用してください。

プラットフォームに関する注意: macOSではウィザードが `gcloud`、`gogcli`、`tailscale` をHomebrewでインストールします。Linuxでは事前に手動でインストールしてください。

Gateway ゲートウェイの自動起動（推奨）:

- `hooks.enabled=true` かつ `hooks.gmail.account` が設定されている場合、Gateway ゲートウェイは起動時に `gog gmail watch serve` を開始し、watchを自動更新します。
- オプトアウトするには `OPENCLAW_SKIP_GMAIL_WATCHER=1` を設定してください（デーモンを自分で実行する場合に便利です）。
- 手動デーモンと同時に実行しないでください。`listen tcp 127.0.0.1:8788: bind: address already in use` が発生します。

手動デーモン（`gog gmail watch serve` + 自動更新を開始）:

```bash
openclaw webhooks gmail run
```

## 初回セットアップ

1. `gog` が使用するOAuthクライアントを**所有するGCPプロジェクト**を選択します。

```bash
gcloud auth login
gcloud config set project <project-id>
```

注意: Gmail watchでは、Pub/SubトピックがOAuthクライアントと同じプロジェクトに存在する必要があります。

2. APIを有効にします:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. トピックを作成します:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. GmailプッシュがPublishできるように許可します:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## watchの開始

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

出力から `history_id` を保存してください（デバッグ用）。

## プッシュハンドラーの実行

ローカルの例（共有トークン認証）:

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

注意事項:

- `--token` はプッシュエンドポイントを保護します（`x-gog-token` または `?token=`）。
- `--hook-url` はOpenClawの `/hooks/gmail` を指します（マッピング済み; 分離実行 + メインへの要約）。
- `--include-body` と `--max-bytes` はOpenClawに送信されるボディスニペットを制御します。

推奨: `openclaw webhooks gmail run` は同じフローをラップし、watchを自動更新します。

## ハンドラーの公開（上級、サポート対象外）

Tailscale以外のトンネルが必要な場合は、手動で設定し、プッシュサブスクリプションでパブリックURLを使用してください（サポート対象外、ガードレールなし）:

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

生成されたURLをプッシュエンドポイントとして使用します:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

本番環境: 安定したHTTPSエンドポイントを使用し、Pub/Sub OIDC JWTを設定してから、以下を実行します:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## テスト

監視対象のInboxにメッセージを送信します:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

watchの状態と履歴を確認します:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## トラブルシューティング

- `Invalid topicName`: プロジェクトの不一致（トピックがOAuthクライアントのプロジェクトにない）。
- `User not authorized`: トピックに `roles/pubsub.publisher` がない。
- メッセージが空: Gmailプッシュは `historyId` のみを提供します。`gog gmail history` で取得してください。

## クリーンアップ

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
