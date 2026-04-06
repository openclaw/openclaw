---
read_when:
    - SecretRefクレデンシャルのカバレッジを検証する場合
    - クレデンシャルが`secrets configure`や`secrets apply`の対象かどうかを監査する場合
    - クレデンシャルがサポート対象サーフェスの範囲外である理由を確認する場合
summary: SecretRefクレデンシャルのサポート対象・非対象の正規サーフェス
title: SecretRefクレデンシャルサーフェス
x-i18n:
    generated_at: "2026-04-02T07:52:06Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d5db3462dcea90191b7a8c4e5c53f28eb81a1411f37f5c6857cadfe3c8cf150e
    source_path: reference/secretref-credential-surface.md
    workflow: 15
---

# SecretRefクレデンシャルサーフェス

このページでは、SecretRefクレデンシャルの正規サーフェスを定義します。

スコープの意図:

- スコープ内: OpenClawが発行やローテーションを行わない、厳密にユーザーが提供するクレデンシャル。
- スコープ外: ランタイムで発行またはローテーションされるクレデンシャル、OAuthリフレッシュマテリアル、セッション類似のアーティファクト。

## サポート対象のクレデンシャル

### `openclaw.json`ターゲット（`secrets configure` + `secrets apply` + `secrets audit`）

[//]: # "secretref-supported-list-start"

- `models.providers.*.apiKey`
- `models.providers.*.headers.*`
- `skills.entries.*.apiKey`
- `agents.defaults.memorySearch.remote.apiKey`
- `agents.list[].memorySearch.remote.apiKey`
- `talk.apiKey`
- `talk.providers.*.apiKey`
- `messages.tts.providers.*.apiKey`
- `tools.web.fetch.firecrawl.apiKey`
- `plugins.entries.brave.config.webSearch.apiKey`
- `plugins.entries.google.config.webSearch.apiKey`
- `plugins.entries.xai.config.webSearch.apiKey`
- `plugins.entries.moonshot.config.webSearch.apiKey`
- `plugins.entries.perplexity.config.webSearch.apiKey`
- `plugins.entries.firecrawl.config.webSearch.apiKey`
- `plugins.entries.tavily.config.webSearch.apiKey`
- `tools.web.search.apiKey`
- `tools.web.x_search.apiKey`
- `gateway.auth.password`
- `gateway.auth.token`
- `gateway.remote.token`
- `gateway.remote.password`
- `cron.webhookToken`
- `channels.telegram.botToken`
- `channels.telegram.webhookSecret`
- `channels.telegram.accounts.*.botToken`
- `channels.telegram.accounts.*.webhookSecret`
- `channels.slack.botToken`
- `channels.slack.appToken`
- `channels.slack.userToken`
- `channels.slack.signingSecret`
- `channels.slack.accounts.*.botToken`
- `channels.slack.accounts.*.appToken`
- `channels.slack.accounts.*.userToken`
- `channels.slack.accounts.*.signingSecret`
- `channels.discord.token`
- `channels.discord.pluralkit.token`
- `channels.discord.voice.tts.providers.*.apiKey`
- `channels.discord.accounts.*.token`
- `channels.discord.accounts.*.pluralkit.token`
- `channels.discord.accounts.*.voice.tts.providers.*.apiKey`
- `channels.irc.password`
- `channels.irc.nickserv.password`
- `channels.irc.accounts.*.password`
- `channels.irc.accounts.*.nickserv.password`
- `channels.bluebubbles.password`
- `channels.bluebubbles.accounts.*.password`
- `channels.feishu.appSecret`
- `channels.feishu.encryptKey`
- `channels.feishu.verificationToken`
- `channels.feishu.accounts.*.appSecret`
- `channels.feishu.accounts.*.encryptKey`
- `channels.feishu.accounts.*.verificationToken`
- `channels.msteams.appPassword`
- `channels.mattermost.botToken`
- `channels.mattermost.accounts.*.botToken`
- `channels.matrix.accessToken`
- `channels.matrix.password`
- `channels.matrix.accounts.*.accessToken`
- `channels.matrix.accounts.*.password`
- `channels.nextcloud-talk.botSecret`
- `channels.nextcloud-talk.apiPassword`
- `channels.nextcloud-talk.accounts.*.botSecret`
- `channels.nextcloud-talk.accounts.*.apiPassword`
- `channels.zalo.botToken`
- `channels.zalo.webhookSecret`
- `channels.zalo.accounts.*.botToken`
- `channels.zalo.accounts.*.webhookSecret`
- `channels.googlechat.serviceAccount`（隣接する`serviceAccountRef`経由、互換性例外）
- `channels.googlechat.accounts.*.serviceAccount`（隣接する`serviceAccountRef`経由、互換性例外）

### `auth-profiles.json`ターゲット（`secrets configure` + `secrets apply` + `secrets audit`）

- `profiles.*.keyRef`（`type: "api_key"`、`auth.profiles.<id>.mode = "oauth"`の場合は非サポート）
- `profiles.*.tokenRef`（`type: "token"`、`auth.profiles.<id>.mode = "oauth"`の場合は非サポート）

[//]: # "secretref-supported-list-end"

注意事項:

- 認証プロファイルのプランターゲットには`agentId`が必要です。
- プランエントリは`profiles.*.key` / `profiles.*.token`をターゲットとし、隣接するref（`keyRef` / `tokenRef`）を書き込みます。
- 認証プロファイルのrefは、ランタイム解決と監査カバレッジに含まれます。
- OAuthポリシーガード: `auth.profiles.<id>.mode = "oauth"`は、そのプロファイルのSecretRef入力と組み合わせることができません。このポリシーに違反すると、起動/リロードおよび認証プロファイルの解決が即座に失敗します。
- SecretRef管理のモデルプロバイダーでは、生成された`agents/*/agent/models.json`エントリは`apiKey`/ヘッダーサーフェスに対して非シークレットマーカー（解決済みのシークレット値ではなく）を永続化します。
- マーカーの永続化はソース権威です: OpenClawはアクティブなソース設定スナップショット（解決前）からマーカーを書き込み、解決済みのランタイムシークレット値からは書き込みません。
- Web検索について:
  - 明示的プロバイダーモード（`tools.web.search.provider`が設定済み）では、選択されたプロバイダーのキーのみがアクティブになります。
  - 自動モード（`tools.web.search.provider`が未設定）では、優先順位によって解決される最初のプロバイダーキーのみがアクティブになります。
  - 自動モードでは、選択されていないプロバイダーのrefは、選択されるまで非アクティブとして扱われます。
  - レガシーの`tools.web.search.*`プロバイダーパスは互換性ウィンドウ中も解決されますが、正規のSecretRefサーフェスは`plugins.entries.<plugin>.config.webSearch.*`です。

## サポート対象外のクレデンシャル

スコープ外のクレデンシャルは以下の通りです:

[//]: # "secretref-unsupported-list-start"

- `commands.ownerDisplaySecret`
- `hooks.token`
- `hooks.gmail.pushToken`
- `hooks.mappings[].sessionKey`
- `auth-profiles.oauth.*`
- `channels.discord.threadBindings.webhookToken`
- `channels.discord.accounts.*.threadBindings.webhookToken`
- `channels.whatsapp.creds.json`
- `channels.whatsapp.accounts.*.creds.json`

[//]: # "secretref-unsupported-list-end"

理由:

- これらのクレデンシャルは、発行済み、ローテーション対象、セッション保持、またはOAuth永続クラスであり、読み取り専用の外部SecretRef解決には適合しません。
