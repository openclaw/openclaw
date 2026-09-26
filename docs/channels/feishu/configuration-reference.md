---
summary: "Every `channels.feishu` configuration key with its default"
read_when:
  - Looking up a `channels.feishu` configuration key
  - Checking the default value of a Feishu setting
title: "Feishu configuration reference"
sidebarTitle: "Configuration reference"
---

The full `channels.feishu` key list with defaults, plus the webhook path rules.

## Configuration reference

Full configuration: [Gateway configuration](/gateway/configuration)

| Setting                                                  | Description                                                                                                                | Default                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `channels.feishu.enabled`                                | Enable/disable the channel                                                                                                 | `true`                               |
| `channels.feishu.domain`                                 | API domain (`feishu`, `lark`, or an `https://` base URL)                                                                   | `feishu`                             |
| `channels.feishu.connectionMode`                         | Event transport (`websocket` or `webhook`)                                                                                 | `websocket`                          |
| `channels.feishu.defaultAccount`                         | Default account for outbound routing                                                                                       | `default`                            |
| `channels.feishu.verificationToken`                      | Required for webhook mode                                                                                                  | -                                    |
| `channels.feishu.encryptKey`                             | Required for webhook mode                                                                                                  | -                                    |
| `channels.feishu.webhookPath`                            | Canonical HTTP request path (must start with `/`)                                                                          | `/feishu/events`                     |
| `channels.feishu.legacyWebhook`                          | Legacy forwarding listener: omitted preserves the historical endpoint, `{ port, host? }` overrides it, `false` disables it | `{ port: 3000, host: "127.0.0.1" }`  |
| `channels.feishu.accounts.<id>.appId`                    | App ID                                                                                                                     | -                                    |
| `channels.feishu.accounts.<id>.appSecret`                | App Secret                                                                                                                 | -                                    |
| `channels.feishu.accounts.<id>.domain`                   | Per-account domain override                                                                                                | `feishu`                             |
| `channels.feishu.accounts.<id>.replyToMode`              | Per-account reply-reference mode                                                                                           | inherited                            |
| `channels.feishu.accounts.<id>.tts`                      | Per-account TTS override                                                                                                   | `tts`                                |
| `channels.feishu.accounts.<id>.actions.sticker`          | Per-account sticker action override                                                                                        | inherited                            |
| `channels.feishu.dmPolicy`                               | DM policy (`pairing`, `allowlist`, `open`)                                                                                 | `pairing`                            |
| `channels.feishu.allowFrom`                              | DM allowlist (open_id list)                                                                                                | -                                    |
| `channels.feishu.groupPolicy`                            | Group policy (`open`, `allowlist`, `disabled`)                                                                             | `allowlist`                          |
| `channels.feishu.groupAllowFrom`                         | Group allowlist                                                                                                            | -                                    |
| `channels.feishu.groupSenderAllowFrom`                   | Sender allowlist applied to all groups                                                                                     | -                                    |
| `channels.feishu.requireMention`                         | Require @mention in groups                                                                                                 | `true` (`false` when policy `open`)  |
| `channels.feishu.allowBots`                              | Accept other bots that mention this bot, with bot-loop protection                                                          | `false`                              |
| `channels.feishu.groups.<chat_id>.requireMention`        | Per-group @mention override; explicit IDs also admit the group in allowlist mode                                           | inherited                            |
| `channels.feishu.groups.<chat_id>.enabled`               | Enable/disable a specific group                                                                                            | `true`                               |
| `channels.feishu.groups.<chat_id>.allowFrom`             | Per-group sender allowlist (overrides `groupSenderAllowFrom`)                                                              | -                                    |
| `channels.feishu.groupSessionScope`                      | Group session mapping (`group`, `group_sender`, `group_topic`, `group_topic_sender`)                                       | `group`                              |
| `channels.feishu.replyToMode`                            | Reply-reference mode (`off`, `first`, `all`, `batched`)                                                                    | `all`                                |
| `channels.feishu.replyInThread`                          | Bot replies create/continue topic threads (`disabled`, `enabled`)                                                          | `disabled`                           |
| `channels.feishu.reactionNotifications`                  | Inbound reaction events (`off`, `own`, `all`)                                                                              | `own`                                |
| `channels.feishu.actions.sticker`                        | Enable received-sticker sending and configured sticker search                                                              | `false`                              |
| `channels.feishu.stickerSets`                            | Searchable received-sticker keys and keywords, grouped by bot app ID                                                       | none                                 |
| `channels.feishu.vcAutoJoin`                             | Join invited VC meetings after normal DM authorization                                                                     | `false`                              |
| `channels.feishu.dynamicAgentCreation.enabled`           | Enable automatic per-user agent creation                                                                                   | `false`                              |
| `channels.feishu.dynamicAgentCreation.workspaceTemplate` | Path template for dynamic agent workspaces                                                                                 | `~/.openclaw/workspace-{agentId}`    |
| `channels.feishu.dynamicAgentCreation.agentDirTemplate`  | Agent directory name template                                                                                              | `~/.openclaw/agents/{agentId}/agent` |
| `channels.feishu.dynamicAgentCreation.maxAgents`         | Maximum number of dynamic agents to create                                                                                 | unlimited                            |
| `channels.feishu.textChunkLimit`                         | Message chunk size                                                                                                         | `4000`                               |
| `channels.feishu.streaming.chunkMode`                    | Chunk splitting (`length` or `newline`)                                                                                    | `length`                             |
| `channels.feishu.mediaMaxMb`                             | Media size limit                                                                                                           | `30`                                 |
| `channels.feishu.renderMode`                             | Reply rendering (`auto`, `raw`, `card`)                                                                                    | `auto`                               |
| `channels.feishu.streaming.mode`                         | Streaming card output (`partial` or `off`)                                                                                 | `partial`                            |
| `channels.feishu.streaming.block.enabled`                | Completed-block reply streaming                                                                                            | `false`                              |
| `channels.feishu.typingIndicator`                        | Send typing reactions                                                                                                      | `true`                               |
| `channels.feishu.resolveSenderNames`                     | Resolve sender display names                                                                                               | `true`                               |
| `channels.feishu.configWrites`                           | Allow channel-initiated config writes (needed by dynamic agents)                                                           | `true`                               |
| `channels.feishu.tools.doc`                              | Enable document tools                                                                                                      | `true`                               |
| `channels.feishu.tools.chat`                             | Enable chat info tools                                                                                                     | `true`                               |
| `channels.feishu.tools.wiki`                             | Enable knowledge base tools (requires `doc`)                                                                               | `true`                               |
| `channels.feishu.tools.drive`                            | Enable cloud storage tools                                                                                                 | `true`                               |
| `channels.feishu.tools.perm`                             | Enable permission management tools                                                                                         | `false`                              |
| `channels.feishu.tools.scopes`                           | Enable app scopes diagnostic tool                                                                                          | `true`                               |
| `channels.feishu.tools.bitable`                          | Enable Bitable/Base tools                                                                                                  | `true`                               |
| `channels.feishu.accounts.<id>.tools.bitable`            | Per-account Bitable/Base tool gate                                                                                         | inherited                            |

In webhook mode, both `channels.feishu.webhookPath` and
`channels.feishu.accounts.<id>.webhookPath` must be canonical HTTP request paths
beginning with `/`, such as `/feishu/events`. An optional query string is
supported and must match exactly. Full URLs, relative paths, URL fragments, dot
segments, and unencoded spaces or Unicode are rejected. If an existing
configuration contains a noncanonical path, run `openclaw doctor --fix` to
repair it before starting the gateway.

## Gateway webhook route

Webhook mode uses the Gateway HTTP listener (`gateway.port`, normally `18789`)
at `webhookPath`, normally `/feishu/events`. Configure the public Feishu callback
URL or reverse proxy to reach that Gateway port and path. The route verifies
Feishu signatures and does not require Gateway bearer authentication. Accounts
can share a path when their encrypt keys are distinct; ambiguous signatures on
the Gateway port are rejected instead of selecting an arbitrary account. Old
accounts that share a path and encrypt key remain distinguishable on their
separate explicit legacy listeners. Give those accounts distinct encrypt keys or
webhook paths before moving their callbacks to the shared Gateway port.

Accounts sharing a Gateway path share its unauthenticated request-rate and
in-flight body-read budgets because signature verification needs the complete
body. Use distinct `webhookPath` pathnames for separate budgets. Trusted legacy
endpoints retain independent in-flight capacity even when their paths match.

Webhook mode also preserves the previous endpoint on `127.0.0.1:3000` when
`legacyWebhook` is omitted. The Gateway owns this listener and forwards requests
to the same plugin route and signature verifier. Set
`legacyWebhook: { port: 3100, host: "127.0.0.1" }` to override the endpoint.
An omitted object `host` binds to `127.0.0.1`; explicit hosts, including wildcard
addresses, are preserved. Account entries inherit the root setting, and
`accounts.<id>.legacyWebhook: false` disables forwarding for that account.
A shared legacy socket stays open while another account still uses that endpoint.
On account shutdown, authenticated responses may finish for up to five seconds,
matching the previous listener's close grace period. Unfinished responses close
at that deadline; other accounts keep their routes and listeners.
During that grace period, correctly signed callbacks for the stopping account
receive a retryable `503` unless a live successor already accepts their signature.

On update, the plugin's Doctor migration moves `webhookPort` and `webhookHost`
into `legacyWebhook: { port, host }`, preserving the effective old defaults when
only one key was set. Doctor's normal config backup protects the original
settings. Existing canonical `legacyWebhook` settings, including `false`, win.
An install that omitted both old settings keeps receiving traffic on port `3000`.

To use only the Gateway port, update the Feishu callback URL or reverse-proxy
upstream to the Gateway port and `webhookPath`, verify delivery, then set
`legacyWebhook: false`. Removing that setting restores the inherited or default
endpoint. Startup and Doctor print the destination and disable instruction.
Doctor presents healthy endpoint guidance as information and path conflicts as
warnings; disabled accounts and WebSocket accounts receive no webhook notes.
OpenClaw cannot update callback URLs stored in the Feishu console.

The exact Gateway probe paths (`/health`, `/healthz`, `/ready`, `/readyz`,
`/startup`, and `/startupz`, including query strings) cannot receive Feishu
callbacks on the Gateway port. With `legacyWebhook: false`, webhook startup
refuses these paths and names the replacement. The legacy listener continues
serving the old path when enabled. Change `webhookPath` to `/feishu/events` (or
another unreserved path), update the Feishu callback URL or reverse-proxy path,
and verify delivery on the Gateway before setting `legacyWebhook: false`.
Paths nested below a probe path are not reserved by this rule.

Paths under `/api/channels` require Gateway authentication and cannot receive
ordinary Feishu callbacks on the Gateway port. This also applies to encoded
forms of that prefix. Startup and Doctor give the same path-change instructions;
legacy listeners keep those callbacks working until the path and external
callback or proxy are migrated.
