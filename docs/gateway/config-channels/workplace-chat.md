---
summary: "Per-channel config keys for Google Chat, Slack, Mattermost, and Microsoft Teams"
read_when:
  - Configuring Google Chat, Slack, Mattermost, or Microsoft Teams
  - Setting Slack tokens, thread scope, streaming, or exec approvals
  - Enabling Mattermost native slash commands
title: "Configuration — workplace chat channels"
---

`channels.*` keys for the workplace chat channels: Google Chat, Slack, Mattermost, and Microsoft Teams.

## Google Chat

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890",
      dmPolicy: "pairing",
      allowFrom: ["users/1234567890"],
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { enabled: true, requireMention: true },
      },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

- Service account JSON: inline (`serviceAccount`) or file-based (`serviceAccountFile`).
- `serviceAccount` accepts a SecretRef directly.
- Env fallbacks: `GOOGLE_CHAT_SERVICE_ACCOUNT` or `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` (default account only).
- Use `spaces/<spaceId>` or `users/<userId>` for delivery targets.
- `channels.googlechat.dangerouslyAllowNameMatching` re-enables mutable email principal matching (break-glass compatibility mode).

## Slack

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dmPolicy: "pairing",
      allowFrom: ["U123", "U456", "*"],
      dm: { enabled: true, groupEnabled: false, groupChannels: ["G123"] },
      channels: {
        C123: { enabled: true, requireMention: true, allowBots: false },
        C456: {
          enabled: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50,
      allowBots: false,
      reactionNotifications: "own",
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all | batched
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
        initialHistoryLimit: 20,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      typingReaction: "hourglass_flowing_sand",
      unfurlLinks: false,
      unfurlMedia: false,
      textChunkLimit: 4000,
      streaming: {
        mode: "partial", // off | partial | block | progress
        chunkMode: "length", // length | newline
        nativeTransport: true, // use Slack native streaming API when mode=partial
      },
      mediaMaxMb: 20,
      execApprovals: {
        enabled: "auto", // true | false | "auto"
        approvers: ["U123"],
        agentFilter: ["default"],
        sessionFilter: ["slack:"],
        target: "dm", // dm | channel | both
      },
    },
  },
}
```

- **Socket mode** requires both `botToken` and `appToken` (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` for default account env fallback).
- **HTTP mode** requires `botToken` plus `signingSecret` (at root or per-account).
- `channels.slack.joinIntro` defaults to `true`. When the bot joins an allowed channel, it posts one introduction using the channel name, purpose or topic, and available recent messages. Set this option to `false` to disable introductions, or use `channels.slack.accounts.<accountId>.joinIntro` for an account-specific override. Up to 100 recent messages are read, once per channel; see [group join introductions](/channels#group-join-introductions). Introductions never run in direct messages.
- **User identity** (`postAs: "user"`) posts and reads as the authorizing human. It requires `userToken` plus `appToken` in Socket Mode, or `userToken` plus `signingSecret` in HTTP mode. No bot token or bot user is required. See [User identity](/channels/slack/setup#user-identity-post-as-a-real-person) for user scopes and event subscriptions.
- Slack detects Enterprise Grid org-wide installations automatically from the
  bot token with `auth.test`; no installation-mode setting is required.
  Enterprise DMs support `disabled`, `open`, `allowlist`, and workspace-scoped
  `pairing`. Channel policies require `team:<team-id>:channel:<channel-id>`.
  User policies accept either an org-wide stable user ID or
  `team:<team-id>:user:<user-id>` for workspace scope. Mutable names and
  unsupported channel prefixes fail startup.
  Mention-pattern channel scopes and static route-binding peers use
  workspace-qualified Slack targets.
  Direct Socket Mode or HTTP messages, mentions, workspace-qualified actions,
  deferred delivery, proactive sends, supported event listeners and
  interactions, static route bindings, and Slack-native approvals from
  workspace-qualified turns are supported. Relay, channel-ID-change events,
  App Home, Agent and Assistant lifecycle events, configured ACP bindings, and
  runtime current-conversation bindings remain unavailable. See
  [Enterprise Grid org-wide installs](/channels/slack/enterprise-grid#enterprise-grid-org-wide-installs)
  for the least-privilege manifest, setup workflow, and complete restrictions.
- The retired `enterpriseOrgInstall` key is removed by `openclaw doctor --fix`
  at the Slack root and account levels.
- `botToken`, `appToken`, `signingSecret`, and `userToken` accept plaintext
  strings or SecretRef objects.
- Slack account snapshots expose per-credential source/status fields such as
  `botTokenSource`, `botTokenStatus`, `userTokenSource`, `userTokenStatus`,
  `appTokenStatus`, and, in HTTP mode, `signingSecretStatus`.
  `configured_unavailable` means the account is
  configured through SecretRef but the current command/runtime path could not
  resolve the secret value.
- `configWrites: false` blocks Slack-initiated config writes.
- Optional `channels.slack.defaultAccount` overrides default account selection when it matches a configured account id.
- `dm.groupEnabled` and `dm.groupChannels` only filter Slack group DMs (MPDMs) the app is already a member of. They cannot make the app see an existing group DM it never joined; convert the group DM to a private channel and invite the app, or have the app open a new MPDM with `conversations.open`. See [Group DMs (MPDMs) and bots](/channels/slack/access-control#group-dms-mpdms-and-bots).
- `channels.slack.streaming.mode` is the canonical Slack stream mode key (default `"progress"`). `channels.slack.streaming.nativeTransport` controls Slack's native streaming transport (default `true`). Legacy `streamMode`, boolean `streaming`, `chunkMode`, `blockStreaming`, `blockStreamingCoalesce`, and `nativeStreaming` values are no longer read at runtime; run `openclaw doctor --fix` to migrate persisted config to `streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport}`.
- `unfurlLinks` and `unfurlMedia` pass Slack's `chat.postMessage` link and media unfurl booleans through for bot replies. `unfurlLinks` defaults to `false` so outbound bot links do not expand inline unless enabled; `unfurlMedia` is omitted unless configured. Set either value at `channels.slack.accounts.<accountId>` to override the top-level value for one account.
- Use `user:<id>` (DM) or `channel:<id>` for delivery targets.

**Reaction notification modes:** `off`, `own` (default), `all`, `allowlist` (from `reactionAllowlist`).

**Thread session isolation:** `thread.historyScope` is per-thread (default) or shared across channel. `thread.inheritParent` copies parent channel transcript to new threads. `thread.initialHistoryLimit` (default `20`) caps how many existing thread messages are fetched when a new thread session starts; `0` disables thread history fetching.

- Slack native streaming plus the Slack assistant-style "is typing..." thread status require a reply thread target. Top-level DMs stay off-thread by default, so they can still stream through Slack draft post-and-edit previews instead of showing the thread-style native stream/status preview.
- `typingReaction` adds a temporary reaction to the inbound Slack message while a reply is running, then removes it on completion. Use a Slack emoji shortcode such as `"hourglass_flowing_sand"`.
- `channels.slack.execApprovals`: Slack-native approval-client delivery and exec approver authorization. Same schema as Discord: `enabled` (`true`/`false`/`"auto"`), `approvers` (Slack user IDs), `agentFilter`, `sessionFilter`, and `target` (`"dm"`, `"channel"`, or `"both"`). Plugin approvals can use this native-client path for Slack-origin requests when Slack plugin approvers resolve; Slack-native plugin approval delivery can also be enabled through `approvals.plugin` for Slack-origin sessions or Slack targets. Plugin approvals use Slack plugin approvers from `allowFrom` and default routing, not exec approvers.

| Action group | Default | Notes                  |
| ------------ | ------- | ---------------------- |
| reactions    | enabled | React + list reactions |
| messages     | enabled | Read/send/edit/delete  |
| pins         | enabled | Pin/unpin/list         |
| memberInfo   | enabled | Member info            |
| emojiList    | enabled | List custom emoji      |

## Mattermost

Mattermost installs as a separate plugin, the same way Discord, Slack, and WhatsApp do:

```bash
openclaw plugins install @openclaw/mattermost
```

Check [npmjs.com/package/@openclaw/mattermost](https://www.npmjs.com/package/@openclaw/mattermost) for the current dist-tags before pinning a version.

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      groups: {
        "*": { requireMention: true },
        "team-channel-id": { requireMention: false },
      },
      commands: {
        native: true, // opt-in
        nativeSkills: true,
        callbackPath: "/api/channels/mattermost/command",
        // Optional explicit URL for reverse-proxy/public deployments
        callbackUrl: "https://gateway.example.com/api/channels/mattermost/command",
      },
      textChunkLimit: 4000,
      streaming: { chunkMode: "length" },
    },
  },
}
```

Chat modes: `oncall` (respond on @-mention, default), `onmessage` (every message), `onchar` (messages starting with trigger prefix).

When Mattermost native commands are enabled:

- `commands.callbackPath` must be a path (for example `/api/channels/mattermost/command`), not a full URL.
- `commands.callbackUrl` must resolve to the OpenClaw gateway endpoint and be reachable from the Mattermost server.
- Native slash callbacks are authenticated with the per-command tokens returned
  by Mattermost during slash command registration. If registration fails or no
  commands are activated, OpenClaw rejects callbacks with
  `Unauthorized: invalid command token.`
- For private/tailnet/internal callback hosts, Mattermost may require
  `ServiceSettings.AllowedUntrustedInternalConnections` to include the callback host/domain.
  Use host/domain values, not full URLs.
- `channels.mattermost.configWrites`: allow or deny Mattermost-initiated config writes.
- `channels.mattermost.requireMention`: require `@mention` before replying in channels.
- `channels.mattermost.groups.<channelId>.requireMention`: per-channel mention-gating override (`"*"` for default).
- Optional `channels.mattermost.defaultAccount` overrides default account selection when it matches a configured account id.

## Microsoft Teams

Microsoft Teams is plugin-backed and configured under `channels.msteams`.

```json5
{
  channels: {
    msteams: {
      enabled: true,
      configWrites: true,
      // appId, appPassword, tenantId, webhook, team/channel policies:
      // see /channels/msteams
    },
  },
}
```

- Core key paths covered here: `channels.msteams`, `channels.msteams.configWrites`.
- Full Teams config (credentials, webhook, DM/group policy, per-team/per-channel overrides) is documented in [Microsoft Teams](/channels/msteams).
