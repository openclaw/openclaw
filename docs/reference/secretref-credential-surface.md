---
summary: "Canonical supported vs unsupported SecretRef credential surface"
read_when:
  - Verifying SecretRef credential coverage
  - Auditing whether a credential is eligible for `secrets configure` or `secrets apply`
  - Verifying why a credential is outside the supported surface
title: "SecretRef credential surface"
---

This page defines the canonical SecretRef credential surface.

Scope intent:

- In scope: strictly user-supplied credentials that OpenClaw does not mint or rotate.
- Out of scope: runtime-minted or rotating credentials, OAuth refresh material, and session-like artifacts.

## Supported credentials

### `openclaw.json` targets (`secrets configure` + `secrets apply` + `secrets audit`)

[//]: # "secretref-supported-list-start"

- `agents.defaults.memorySearch.remote.apiKey`
- `agents.list[].memorySearch.remote.apiKey`
- `agents.list[].tts.providers.*.apiKey`
- `channels.discord.accounts.*.pluralkit.token`
- `channels.discord.accounts.*.token`
- `channels.discord.accounts.*.voice.tts.providers.*.apiKey`
- `channels.discord.pluralkit.token`
- `channels.discord.token`
- `channels.discord.voice.tts.providers.*.apiKey`
- `channels.feishu.accounts.*.appSecret`
- `channels.feishu.accounts.*.encryptKey`
- `channels.feishu.accounts.*.verificationToken`
- `channels.feishu.appSecret`
- `channels.feishu.encryptKey`
- `channels.feishu.verificationToken`
- `channels.googlechat.accounts.*.serviceAccount` via sibling `serviceAccountRef` (compatibility exception)
- `channels.googlechat.serviceAccount` via sibling `serviceAccountRef` (compatibility exception)
- `channels.irc.accounts.*.nickserv.password`
- `channels.irc.accounts.*.password`
- `channels.irc.nickserv.password`
- `channels.irc.password`
- `channels.matrix.accessToken`
- `channels.matrix.accounts.*.accessToken`
- `channels.matrix.accounts.*.password`
- `channels.matrix.password`
- `channels.mattermost.accounts.*.botToken`
- `channels.mattermost.botToken`
- `channels.msteams.appPassword`
- `channels.nextcloud-talk.accounts.*.apiPassword`
- `channels.nextcloud-talk.accounts.*.botSecret`
- `channels.nextcloud-talk.apiPassword`
- `channels.nextcloud-talk.botSecret`
- `channels.qqbot.accounts.*.clientSecret`
- `channels.qqbot.clientSecret`
- `channels.slack.accounts.*.appToken`
- `channels.slack.accounts.*.botToken`
- `channels.slack.accounts.*.signingSecret`
- `channels.slack.accounts.*.userToken`
- `channels.slack.appToken`
- `channels.slack.botToken`
- `channels.slack.signingSecret`
- `channels.slack.userToken`
- `channels.telegram.accounts.*.botToken`
- `channels.telegram.accounts.*.webhookSecret`
- `channels.telegram.botToken`
- `channels.telegram.webhookSecret`
- `channels.zalo.accounts.*.botToken`
- `channels.zalo.accounts.*.webhookSecret`
- `channels.zalo.botToken`
- `channels.zalo.webhookSecret`
- `cron.webhookToken`
- `gateway.auth.password`
- `gateway.auth.token`
- `gateway.remote.password`
- `gateway.remote.token`
- `messages.tts.providers.*.apiKey`
- `models.providers.*.apiKey`
- `models.providers.*.headers.*`
- `models.providers.*.request.auth.token`
- `models.providers.*.request.auth.value`
- `models.providers.*.request.headers.*`
- `models.providers.*.request.proxy.tls.ca`
- `models.providers.*.request.proxy.tls.cert`
- `models.providers.*.request.proxy.tls.key`
- `models.providers.*.request.proxy.tls.passphrase`
- `models.providers.*.request.tls.ca`
- `models.providers.*.request.tls.cert`
- `models.providers.*.request.tls.key`
- `models.providers.*.request.tls.passphrase`
- `plugins.entries.acpx.config.mcpServers.*.env.*`
- `plugins.entries.brave.config.webSearch.apiKey`
- `plugins.entries.exa.config.webSearch.apiKey`
- `plugins.entries.firecrawl.config.webSearch.apiKey`
- `plugins.entries.google.config.webSearch.apiKey`
- `plugins.entries.minimax.config.webSearch.apiKey`
- `plugins.entries.moonshot.config.webSearch.apiKey`
- `plugins.entries.perplexity.config.webSearch.apiKey`
- `plugins.entries.tavily.config.webSearch.apiKey`
- `plugins.entries.voice-call.config.realtime.providers.*.apiKey`
- `plugins.entries.voice-call.config.streaming.providers.*.apiKey`
- `plugins.entries.voice-call.config.tts.providers.*.apiKey`
- `plugins.entries.voice-call.config.twilio.authToken`
- `plugins.entries.xai.config.webSearch.apiKey`
- `skills.entries.*.apiKey`
- `talk.providers.*.apiKey`
- `tools.web.fetch.firecrawl.apiKey`
- `tools.web.search.*.apiKey`
- `tools.web.search.apiKey`

### `auth-profiles.json` targets (`secrets configure` + `secrets apply` + `secrets audit`)

- `profiles.*.keyRef` (`type: "api_key"`; unsupported when `auth.profiles.<id>.mode = "oauth"`)
- `profiles.*.tokenRef` (`type: "token"`; unsupported when `auth.profiles.<id>.mode = "oauth"`)

[//]: # "secretref-supported-list-end"

Notes:

- Auth-profile plan targets require `agentId`.
- Plan entries target `profiles.*.key` / `profiles.*.token` and write sibling refs (`keyRef` / `tokenRef`).
- Auth-profile refs are included in runtime resolution and audit coverage.
- In `openclaw.json`, SecretRefs must use structured objects such as `{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}`. Legacy `secretref-env:<ENV_VAR>` marker strings are rejected on SecretRef credential paths; run `openclaw doctor --fix` to migrate valid markers.
- OAuth policy guard: `auth.profiles.<id>.mode = "oauth"` cannot be combined with SecretRef inputs for that profile. Startup/reload and auth-profile resolution fail fast when this policy is violated.
- For SecretRef-managed model providers, generated `agents/*/agent/models.json` entries persist non-secret markers (not resolved secret values) for `apiKey`/header surfaces.
- Marker persistence is source-authoritative: OpenClaw writes markers from the active source config snapshot (pre-resolution), not from resolved runtime secret values.
- For web search:
  - In explicit provider mode (`tools.web.search.provider` set), only the selected provider key is active.
  - In auto mode (`tools.web.search.provider` unset), only the first provider key that resolves by precedence is active.
  - In auto mode, non-selected provider refs are treated as inactive until selected.
  - Legacy `tools.web.search.*` provider paths still resolve during the compatibility window, but the canonical SecretRef surface is `plugins.entries.<plugin>.config.webSearch.*`.

## Unsupported credentials

Out-of-scope credentials include:

[//]: # "secretref-unsupported-list-start"

- `commands.ownerDisplaySecret`
- `hooks.token`
- `hooks.gmail.pushToken`
- `hooks.mappings[].sessionKey`
- `auth-profiles.oauth.*`
- `channels.discord.accounts.*.threadBindings.webhookToken`
- `channels.discord.threadBindings.webhookToken`
- `channels.whatsapp.accounts.*.creds.json`
- `channels.whatsapp.creds.json`

[//]: # "secretref-unsupported-list-end"

Rationale:

- These credentials are minted, rotated, session-bearing, or OAuth-durable classes that do not fit read-only external SecretRef resolution.

## Related

- [Secrets management](/gateway/secrets)
- [Auth credential semantics](/auth-credential-semantics)
