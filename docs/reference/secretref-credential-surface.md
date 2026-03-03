---
summary: "Canonical supported vs unsupported SecretRef credential surface"
read_when:
  - Verifying SecretRef credential coverage
  - Auditing whether a credential is eligible for `secrets configure` or `secrets apply`
  - Verifying why a credential is outside the supported surface
title: "SecretRef Credential Surface"
---

# SecretRef credential surface

This page defines the canonical SecretRef credential surface.

Scope intent:

- In scope: strictly user-supplied credentials that OpenClaw does not mint or rotate.
- Out of scope: runtime-minted or rotating credentials, OAuth refresh material, and session-like artifacts.

## Supported credentials

### `openclaw.json` targets (`secrets configure` + `secrets apply` + `secrets audit`)

<!-- secretref-supported-list-start -->

- `models.providers.*.apiKey`
- `skills.entries.*.apiKey`
- `agents.defaults.memorySearch.remote.apiKey`
- `agents.list[].memorySearch.remote.apiKey`
- `talk.apiKey`
- `talk.providers.*.apiKey`
- `messages.tts.elevenlabs.apiKey`
- `messages.tts.openai.apiKey`
- `tools.web.search.apiKey`
- `tools.web.search.gemini.apiKey`
- `tools.web.search.grok.apiKey`
- `tools.web.search.kimi.apiKey`
- `tools.web.search.perplexity.apiKey`
- `gateway.auth.password`
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
- `channels.feishu.verificationToken`
- `channels.feishu.accounts.*.appSecret`
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
- `channels.googlechat.serviceAccount` via sibling `serviceAccountRef` (compatibility exception)
- `channels.googlechat.accounts.*.serviceAccount` via sibling `serviceAccountRef` (compatibility exception)

### `auth-profiles.json` targets (`secrets configure` + `secrets apply` + `secrets audit`)

- `profiles.*.keyRef` (`type: "api_key"`)
- `profiles.*.tokenRef` (`type: "token"`)
<!-- secretref-supported-list-end -->

Notes:

- Auth-profile plan targets require `agentId`.
- Plan entries target `profiles.*.key` / `profiles.*.token` and write sibling refs (`keyRef` / `tokenRef`).
- Auth-profile refs are included in runtime resolution and audit coverage.
- For web search:
  - In explicit provider mode (`tools.web.search.provider` set), only the selected provider key is active.
  - In auto mode (`tools.web.search.provider` unset), `tools.web.search.apiKey` and provider-specific keys are active.

## Unsupported credentials

Out-of-scope credentials include:

<!-- secretref-unsupported-list-start -->

- `gateway.auth.token`
- `commands.ownerDisplaySecret`
- `channels.matrix.accessToken`
- `channels.matrix.accounts.*.accessToken`
- `hooks.token`
- `hooks.gmail.pushToken`
- `hooks.mappings[].sessionKey`
- `auth-profiles.oauth.*`
- `discord.threadBindings.*.webhookToken`
- `whatsapp.creds.json`
<!-- secretref-unsupported-list-end -->

Rationale:

- These credentials are minted, rotated, session-bearing, or OAuth-durable classes that do not fit read-only external SecretRef resolution.
