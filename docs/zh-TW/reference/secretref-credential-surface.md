---
summary: Canonical supported vs unsupported SecretRef credential surface
read_when:
  - Verifying SecretRef credential coverage
  - >-
    Auditing whether a credential is eligible for `secrets configure` or
    `secrets apply`
  - Verifying why a credential is outside the supported surface
title: SecretRef Credential Surface
---

# SecretRef 憑證介面

本頁定義了標準的 SecretRef 憑證介面。

範圍意圖：

- 範圍內：嚴格指使用者提供的憑證，OpenClaw 不會自行產生或輪替。
- 範圍外：執行時產生或輪替的憑證、OAuth 更新憑證資料，以及類似會話的憑證。

## 支援的憑證

### `openclaw.json` 目標 (`secrets configure` + `secrets apply` + `secrets audit`)

[//]: # "secretref-supported-list-start"

- `models.providers.*.apiKey`
- `models.providers.*.headers.*`
- `skills.entries.*.apiKey`
- `agents.defaults.memorySearch.remote.apiKey`
- `agents.list[].memorySearch.remote.apiKey`
- `talk.apiKey`
- `talk.providers.*.apiKey`
- `messages.tts.elevenlabs.apiKey`
- `messages.tts.openai.apiKey`
- `tools.web.fetch.firecrawl.apiKey`
- `tools.web.search.apiKey`
- `tools.web.search.gemini.apiKey`
- `tools.web.search.grok.apiKey`
- `tools.web.search.kimi.apiKey`
- `tools.web.search.perplexity.apiKey`
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
- `channels.discord.voice.tts.elevenlabs.apiKey`
- `channels.discord.voice.tts.openai.apiKey`
- `channels.discord.accounts.*.token`
- `channels.discord.accounts.*.pluralkit.token`
- `channels.discord.accounts.*.voice.tts.elevenlabs.apiKey`
- `channels.discord.accounts.*.voice.tts.openai.apiKey`
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
- `channels.matrix.password`
- `channels.matrix.accounts.*.password`
- `channels.nextcloud-talk.botSecret`
- `channels.nextcloud-talk.apiPassword`
- `channels.nextcloud-talk.accounts.*.botSecret`
- `channels.nextcloud-talk.accounts.*.apiPassword`
- `channels.zalo.botToken`
- `channels.zalo.webhookSecret`
- `channels.zalo.accounts.*.botToken`
- `channels.zalo.accounts.*.webhookSecret`
- `channels.googlechat.serviceAccount` 透過兄弟 `serviceAccountRef`（相容性例外）
- `channels.googlechat.accounts.*.serviceAccount` 透過兄弟 `serviceAccountRef`（相容性例外）

### `auth-profiles.json` 目標 (`secrets configure` + `secrets apply` + `secrets audit`)

- `profiles.*.keyRef` (`type: "api_key"`)
- `profiles.*.tokenRef` (`type: "token"`)

[//]: # "secretref-supported-list-end"

備註：

- 認證設定檔計畫目標需要 `agentId`。
- 計畫條目目標 `profiles.*.key` / `profiles.*.token` 並寫入兄弟參考 (`keyRef` / `tokenRef`)。
- 認證設定檔參考包含於執行時解析與稽核範圍。
- 對於 SecretRef 管理的模型提供者，產生的 `agents/*/agent/models.json` 條目會保留非秘密標記（非解析的秘密值）以供 `apiKey`/標頭介面使用。
- 標記持久化以來源為權威：OpenClaw 從活動來源設定快照（解析前）寫入標記，而非從解析後的執行時秘密值寫入。
- 對於網頁搜尋：
  - 在明確提供者模式（設定 `tools.web.search.provider`）時，僅選定的提供者金鑰有效。
  - 在自動模式（未設定 `tools.web.search.provider`）時，僅依優先順序解析到的第一個提供者金鑰有效。
  - 在自動模式中，未被選定的提供者參考視為非啟用狀態，直到被選中。

## 不支援的憑證

範圍外的憑證包括：

[//]: # "secretref-unsupported-list-start"

- `commands.ownerDisplaySecret`
- `channels.matrix.accessToken`
- `channels.matrix.accounts.*.accessToken`
- `hooks.token`
- `hooks.gmail.pushToken`
- `hooks.mappings[].sessionKey`
- `auth-profiles.oauth.*`
- `discord.threadBindings.*.webhookToken`
- `whatsapp.creds.json`

[//]: # "secretref-unsupported-list-end"

理由：

- 這些憑證是動態產生、輪替、帶有會話或 OAuth 持久性的類別，不適合用於唯讀的外部 SecretRef 解析。
