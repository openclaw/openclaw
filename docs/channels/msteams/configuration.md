---
summary: "Microsoft Teams configuration keys, environment variables, and history limits"
read_when:
  - Looking up a `channels.msteams` configuration key
  - Setting Teams credentials from environment variables
  - Tuning how much history reaches the prompt
title: "Microsoft Teams configuration"
sidebarTitle: "Configuration"
---

The `channels.msteams` settings, the environment variables that stand in for the auth keys, and the history context rules.

## Environment variables

These auth-related config keys can be set via environment variables instead of `openclaw.json` (other config keys, such as `groupPolicy` or `historyLimit`, are config-only):

| Env var                              | Config key                | Notes                               |
| ------------------------------------ | ------------------------- | ----------------------------------- |
| `MSTEAMS_APP_ID`                     | `appId`                   |                                     |
| `MSTEAMS_APP_PASSWORD`               | `appPassword`             |                                     |
| `MSTEAMS_TENANT_ID`                  | `tenantId`                |                                     |
| `MSTEAMS_AUTH_TYPE`                  | `authType`                | `"secret"` or `"federated"`         |
| `MSTEAMS_CERTIFICATE_PATH`           | `certificatePath`         | federated + certificate             |
| `MSTEAMS_CERTIFICATE_THUMBPRINT`     | `certificateThumbprint`   | accepted, not required for auth     |
| `MSTEAMS_USE_MANAGED_IDENTITY`       | `useManagedIdentity`      | federated + managed identity        |
| `MSTEAMS_MANAGED_IDENTITY_CLIENT_ID` | `managedIdentityClientId` | user-assigned managed identity only |

## History context

- `channels.msteams.historyLimit` controls how many recent channel/group messages are wrapped into the prompt. Falls back to `messages.groupChat.historyLimit`, then defaults to 50. Set `0` to disable.
- Graph thread context adds the parent and up to the oldest 50 replies alongside recent channel history. It excludes the triggering message and keeps history separate from the sender's command text, so commands quoted in history do not execute. Long fetched messages retain their beginning and end within the prompt's per-message limit.
- Thread and quoted attachment context follow `channels.msteams.contextVisibility`, falling back to `channels.defaults.contextVisibility`, then `all`. Use `allowlist` to filter both by sender allowlists (`allowFrom` / `groupAllowFrom`), or `allowlist_quote` to filter thread history while permitting quoted context.
- DM history can be limited with `channels.msteams.dmHistoryLimit` (user turns). Per-user overrides: `channels.msteams.dms["<user_id>"].historyLimit`.

## Configuration

Key settings (see [/gateway/configuration](/gateway/configuration) for shared channel patterns):

- `channels.msteams.enabled`: enable/disable the channel.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: bot credentials.
- `channels.msteams.cloud`: Teams SDK cloud environment (`Public`, `USGov`, `USGovDoD`, or `China`; default `Public`). Set with `serviceUrl` for USGov/DoD SDK clouds; China uses the SDK preset and stored Azure China Bot Framework conversation references, with Graph-backed helpers disabled until Azure China Graph routing ships.
- `channels.msteams.serviceUrl`: Bot Connector service URL boundary for SDK proactive operations. Public cloud uses the SDK default; set for GCC (`https://smba.infra.gcc.teams.microsoft.com/teams`), GCC High, or DoD. China accepts Azure China Bot Framework channel hosts when the stored conversation reference comes from Teams operated by 21Vianet.
- `channels.msteams.webhook.port` (default `3978`).
- `channels.msteams.webhook.path` (default `/api/messages`).
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (default `pairing`).
- `channels.msteams.allowFrom`: DM allowlist (AAD object IDs recommended). Stable AAD object IDs also authorize approval actions. The wizard resolves names to IDs during setup when Graph access is available.
- `channels.msteams.defaultTo`: default outbound target; a stable AAD object ID can also authorize approval actions.
- `channels.msteams.dangerouslyAllowNameMatching`: break-glass toggle to re-enable mutable UPN/display-name matching and direct team/channel name routing.
- `channels.msteams.textChunkLimit`: outbound text chunk size in characters (default `4000`, and hard-capped at `4000` regardless of a higher configured value).
- `channels.msteams.streaming.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.
- `channels.msteams.mediaAllowHosts`: allowlist for inbound attachment hosts (defaults to Microsoft/Teams domains: Graph, SharePoint/OneDrive, Teams CDN, Bot Framework, Azure Media Services).
- `channels.msteams.mediaAuthAllowHosts`: allowlist for attaching Authorization headers on media retries (defaults to Graph + Bot Framework hosts).
- `channels.msteams.graphMediaFallback`: opt into Graph message lookups when channel/group HTML omits file markers (default `false`; see [Channel/group file recovery](/channels/msteams/manifest-and-permissions#channel%2Fgroup-file-recovery-graphmediafallback)).
- `channels.msteams.mediaMaxMb`: per-channel media size limit override in MB. Falls back to `agents.defaults.mediaMaxMb` when unset.
- `channels.msteams.requireMention`: require @mention in channels/groups (default `true`).
- `channels.msteams.replyStyle`: `thread | top-level` (see [Reply style](/channels/msteams/messaging#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: per-team override.
- `channels.msteams.teams.<teamId>.requireMention`: per-team override.
- `channels.msteams.teams.<teamId>.tools`: default per-team tool policy overrides (`allow`/`deny`/`alsoAllow`) used when a channel override is missing.
- `channels.msteams.teams.<teamId>.toolsBySender`: default per-team per-sender tool policy overrides (`"*"` wildcard supported).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: per-channel per-sender tool policy overrides (`"*"` wildcard supported).
- `toolsBySender` keys should use explicit prefixes: `channel:`, `id:`, `e164:`, `username:`, `name:` (legacy unprefixed keys still map to `id:` only).
- `channels.msteams.authType`: authentication type - `"secret"` (default) or `"federated"`.
- `channels.msteams.certificatePath`: path to PEM certificate file (federated + certificate auth).
- `channels.msteams.certificateThumbprint`: certificate thumbprint; accepted, not required for auth.
- `channels.msteams.useManagedIdentity`: enable managed identity auth (federated mode).
- `channels.msteams.managedIdentityClientId`: client ID for user-assigned managed identity.
- `channels.msteams.sharePointSiteId`: SharePoint site ID for file uploads in group chats/channels (see [Sending files in group chats](/channels/msteams/messaging#sending-files-in-group-chats)).
- `channels.msteams.welcomeCard`, `channels.msteams.groupWelcomeCard`, `channels.msteams.promptStarters`: welcome Adaptive Card shown on first DM/group contact, and its suggested prompt buttons.
- `channels.msteams.responsePrefix`: text prefixed to outbound replies.
- `channels.msteams.feedbackEnabled` (default `true`), `channels.msteams.feedbackReflection` (default `true`), `channels.msteams.feedbackReflectionCooldownMs`: thumbs-up/down feedback on replies and the negative-feedback reflection follow-up.
- `channels.msteams.sso`, `channels.msteams.delegatedAuth`: Bot Framework OAuth connection and delegated Graph scopes for SSO-backed flows; `sso.enabled: true` requires `sso.connectionName`.
