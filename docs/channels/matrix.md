---
summary: "Matrix support status, setup, and configuration examples"
read_when:
  - Setting up Matrix in OpenClaw
  - Configuring Matrix E2EE and verification
title: "Matrix"
---

Matrix is a downloadable channel plugin (`@openclaw/matrix`) built on the official `matrix-js-sdk`. It supports DMs, rooms, threads, media, reactions, polls, location, and E2EE.

Node remains the recommended runtime. Matrix also accepts the [opt-in Bun runtime](/install/bun); E2EE requires the Matrix SDK's native crypto bindings to be available for your platform.

<CardGroup cols={3}>
  <Card title="Setup" icon="download" href="/channels/matrix/setup">
    Install the plugin and connect a homeserver account.
  </Card>
  <Card title="Encryption" icon="lock" href="/channels/matrix/encryption">
    Enable E2EE and verify the gateway device.
  </Card>
  <Card title="Matrix migration" icon="arrows-rotate" href="/channels/matrix-migration">
    Encrypted-state recovery limits and the upgrade flow.
  </Card>
</CardGroup>

## What each page covers

- [Matrix setup](/channels/matrix/setup) — install the plugin, point it at a homeserver, choose auth, and control invites and allowlists.
- [Matrix access control](/channels/matrix/access-control) — DM and room policy, allowlists, bot-to-bot traffic, context visibility, and command authorization.
- [Matrix message behavior](/channels/matrix/messaging) — streaming previews, inbound voice-note transcription, and reactions.
- [Matrix rich messages and approvals](/channels/matrix/rich-messages) — structured reply controls, approval event metadata, and exec approval prompts.
- [Matrix encryption and verification](/channels/matrix/encryption) — E2EE setup, device verification, cross-signing repair, room-key backup, and crypto-store layout.
- [Matrix threads and sessions](/channels/matrix/threads-and-sessions) — session routing, reply threading, ACP conversation bindings, and room history context.
- [Matrix accounts and homeservers](/channels/matrix/accounts-and-homeservers) — multi-account layout, private/LAN homeservers, proxies, profiles, direct-room repair, and target resolution.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/channels/matrix#streaming-previews` still resolves. Each entry points at the page that now holds the content.

- <a id="install" />[Install](/channels/matrix/setup#install)
- <a id="setup" />[Setup](/channels/matrix/setup#setup)
- <a id="interactive-setup" />[Interactive setup](/channels/matrix/setup#interactive-setup)
- <a id="minimal-config" />[Minimal config](/channels/matrix/setup#minimal-config)
- <a id="auto-join" />[Auto-join](/channels/matrix/setup#auto-join)
- <a id="group-join-introductions" />[Group join introductions](/channels/matrix/setup#group-join-introductions)
- <a id="allowlist-target-formats" />[Allowlist target formats](/channels/matrix/setup#allowlist-target-formats)
- <a id="account-id-normalization" />[Account ID normalization](/channels/matrix/setup#account-id-normalization)
- <a id="cached-credentials" />[Cached credentials](/channels/matrix/setup#cached-credentials)
- <a id="environment-variables" />[Environment variables](/channels/matrix/setup#environment-variables)
- <a id="configuration-example" />[Configuration example](/channels/matrix/setup#configuration-example)
- <a id="streaming-previews" />[Streaming previews](/channels/matrix/messaging#streaming-previews)
- <a id="voice-messages" />[Voice messages](/channels/matrix/messaging#voice-messages)
- <a id="reply-controls-and-presentations" />[Reply controls and presentations](/channels/matrix/rich-messages#reply-controls-and-presentations)
- <a id="approval-metadata" />[Approval metadata](/channels/matrix/rich-messages#approval-metadata)
- <a id="self-hosted-push-rules-for-quiet-finalized-previews" />[Self-hosted push rules for quiet finalized previews](/channels/matrix/rich-messages#self-hosted-push-rules-for-quiet-finalized-previews)
- <a id="bot-to-bot-rooms" />[Bot-to-bot rooms](/channels/matrix/access-control#bot-to-bot-rooms)
- <a id="encryption-and-verification" />[Encryption and verification](/channels/matrix/encryption#encryption-and-verification)
- <a id="enable-encryption" />[Enable encryption](/channels/matrix/encryption#enable-encryption)
- <a id="status-and-trust-signals" />[Status and trust signals](/channels/matrix/encryption#status-and-trust-signals)
- <a id="verify-this-device-with-a-recovery-key" />[Verify this device with a recovery key](/channels/matrix/encryption#verify-this-device-with-a-recovery-key)
- <a id="bootstrap-or-repair-cross-signing" />[Bootstrap or repair cross-signing](/channels/matrix/encryption#bootstrap-or-repair-cross-signing)
- <a id="room-key-backup" />[Room-key backup](/channels/matrix/encryption#room-key-backup)
- <a id="listing%2C-requesting%2C-and-responding-to-verifications" />[Listing, requesting, and responding to verifications](/channels/matrix/encryption#listing%2C-requesting%2C-and-responding-to-verifications)
- <a id="multi-account-notes" />[Multi-account notes](/channels/matrix/encryption#multi-account-notes)
- <a id="profile-management" />[Profile management](/channels/matrix/accounts-and-homeservers#profile-management)
- <a id="threads" />[Threads](/channels/matrix/threads-and-sessions#threads)
- <a id="session-routing-(sessionscope)" />[Session routing (`sessionScope`)](</channels/matrix/threads-and-sessions#session-routing-(sessionscope)>)
- <a id="reply-threading-(threadreplies)" />[Reply threading (`threadReplies`)](</channels/matrix/threads-and-sessions#reply-threading-(threadreplies)>)
- <a id="thread-inheritance-and-slash-commands" />[Thread inheritance and slash commands](/channels/matrix/threads-and-sessions#thread-inheritance-and-slash-commands)
- <a id="acp-conversation-bindings" />[ACP conversation bindings](/channels/matrix/threads-and-sessions#acp-conversation-bindings)
- <a id="thread-binding-config" />[Thread binding config](/channels/matrix/threads-and-sessions#thread-binding-config)
- <a id="reactions" />[Reactions](/channels/matrix/messaging#reactions)
- <a id="history-context" />[History context](/channels/matrix/threads-and-sessions#history-context)
- <a id="context-visibility" />[Context visibility](/channels/matrix/access-control#context-visibility)
- <a id="dm-and-room-policy" />[DM and room policy](/channels/matrix/access-control#dm-and-room-policy)
- <a id="direct-room-repair" />[Direct room repair](/channels/matrix/accounts-and-homeservers#direct-room-repair)
- <a id="exec-approvals" />[Exec approvals](/channels/matrix/rich-messages#exec-approvals)
- <a id="slash-commands" />[Slash commands](/channels/matrix/access-control#slash-commands)
- <a id="multi-account" />[Multi-account](/channels/matrix/accounts-and-homeservers#multi-account)
- <a id="private%2Flan-homeservers" />[Private/LAN homeservers](/channels/matrix/accounts-and-homeservers#private%2Flan-homeservers)
- <a id="proxying-matrix-traffic" />[Proxying Matrix traffic](/channels/matrix/accounts-and-homeservers#proxying-matrix-traffic)
- <a id="target-resolution" />[Target resolution](/channels/matrix/accounts-and-homeservers#target-resolution)
- <a id="listing-requesting-and-responding-to-verifications" />[Listing, requesting, and responding to verifications](/channels/matrix/encryption#listing-requesting-and-responding-to-verifications)
- <a id="session-routing-sessionscope" />[Session routing (`sessionScope`)](/channels/matrix/threads-and-sessions#session-routing-sessionscope)
- <a id="reply-threading-threadreplies" />[Reply threading (`threadReplies`)](/channels/matrix/threads-and-sessions#reply-threading-threadreplies)
- <a id="private/lan-homeservers" />[Private/LAN homeservers](/channels/matrix/accounts-and-homeservers#private/lan-homeservers)
- <a id="startup-behavior" />[Startup behavior](/channels/matrix/encryption#startup-behavior)
- <a id="verification-notices" />[Verification notices](/channels/matrix/encryption#verification-notices)
- <a id="deleted-or-invalid-matrix-device" />[Deleted or invalid Matrix device](/channels/matrix/encryption#deleted-or-invalid-matrix-device)
- <a id="device-hygiene" />[Device hygiene](/channels/matrix/encryption#device-hygiene)
- <a id="crypto-store" />[Crypto store](/channels/matrix/encryption#crypto-store)

## Configuration reference

Allowlist-style user fields (`groupAllowFrom`, `dm.allowFrom`, `groups.<room>.users`) accept full Matrix user IDs (safest). Non-ID entries are ignored by default. If `dangerouslyAllowNameMatching: true` is set, exact Matrix directory display-name matches are resolved at startup and whenever the allowlist changes while the monitor is running; unresolvable entries are ignored at runtime.

Room allowlist keys (`groups`, legacy `rooms`) should be room IDs or aliases. Plain room-name keys are ignored by default; `dangerouslyAllowNameMatching: true` restores best-effort lookup against joined room names.

### Account and connection

- `enabled`: enable or disable the channel.
- `name`: optional display label for the account.
- `defaultAccount`: preferred account ID when multiple Matrix accounts are configured.
- `accounts`: named per-account overrides. Top-level `channels.matrix` values are inherited as defaults.
- `homeserver`: homeserver URL, for example `https://matrix.example.org`.
- `network.dangerouslyAllowPrivateNetwork`: allow this account to connect to `localhost`, LAN/Tailscale IPs, or internal hostnames.
- `proxy`: optional HTTP(S) proxy URL for Matrix traffic. Per-account override supported.
- `userId`: full Matrix user ID (`@bot:example.org`).
- `accessToken`: access token for token-based auth. Plaintext and SecretRef values supported across env/file/exec/store providers ([Secrets Management](/gateway/secrets)).
- `password`: password for password-based login. Plaintext and SecretRef values supported.
- `deviceId`: explicit Matrix device ID.
- `deviceName`: device display name used at password-login time.
- `avatarUrl`: stored self-avatar URL for profile sync and `profile set` updates.
- `initialSyncLimit`: maximum number of events fetched during startup sync.

### Encryption

- `encryption`: enable E2EE. Default: `false`.
- `startupVerification`: `"if-unverified"` (default when E2EE is on) or `"off"`. Auto-requests self-verification on startup when this device is unverified.
- `startupVerificationCooldownHours`: cooldown before the next automatic startup request. Default: `24`.

### Access and policy

- `groupPolicy`: `"open"`, `"allowlist"`, or `"disabled"`. Default: `"allowlist"`.
- `groupAllowFrom`: allowlist of user IDs for room traffic.
- `mentionPatterns`: scoped regex patterns for room mentions. Object with `{ mode: "allow"|"deny", allowIn: [roomId, ...], denyIn: [roomId, ...] }`. Controls whether configured `agents.entries.*.groupChat.mentionPatterns` apply per-room.
- `dm.enabled`: when `false`, ignore all DMs. Default: `true`.
- `dm.policy`: `"pairing"` (default), `"allowlist"`, `"open"`, or `"disabled"`. Applies after the bot has joined and classified the room as a DM; it does not affect invite handling.
- `dm.allowFrom`: allowlist of user IDs for DM traffic.
- `dm.sessionScope`: `"per-user"` (default) or `"per-room"`.
- `dm.threadReplies`: DM-only override for reply threading (`"off"`, `"inbound"`, `"always"`).
- `allowBots`: accept messages from other configured Matrix bot accounts (`true` or `"mentions"`).
- `allowlistOnly`: when `true`, forces all active DM policies (except `"disabled"`) and `"open"` group policies to `"allowlist"`. Does not change `"disabled"` policies.
- `dangerouslyAllowNameMatching`: when `true`, allows Matrix display-name directory lookup for user allowlist entries and joined-room name lookup for room allowlist keys. Prefer full `@user:server` IDs and room IDs or aliases.
- `autoJoin`: `"always"`, `"allowlist"`, or `"off"`. Default: `"off"`. Applies to every Matrix invite, including DM-style invites.
- `autoJoinAllowlist`: rooms/aliases allowed when `autoJoin` is `"allowlist"`. Alias entries resolve against the homeserver, not against state claimed by the invited room.
- `contextVisibility`: supplemental context visibility (`"all"` default, `"allowlist"`, `"allowlist_quote"`).

### Reply behavior

- `joinIntro`: introduce when the bot joins an allowed group room. Default: `true`. Per-account override: `accounts.<accountId>.joinIntro`.
- `replyToMode`: `"off"` (default), `"first"`, `"all"`, or `"batched"`.
- `threadReplies`: `"off"` (top-level default resolves to `"inbound"` unless explicitly set), `"inbound"`, or `"always"`.
- `threadBindings`: per-channel overrides for thread-bound session routing and lifecycle.
- `streaming`: nested object `{ mode, chunkMode, block: { enabled, coalesce }, preview: { toolProgress }, progress: { label, labels, maxLines, maxLineChars, toolProgress } }`. `mode` is `"off"` (default), `"partial"`, `"quiet"`, or `"progress"`. Legacy scalar/boolean spellings migrate via `openclaw doctor --fix`.
- `streaming.block.enabled`: when `true`, completed assistant blocks are kept as separate progress messages. Default: `false`.
- `markdown`: optional Markdown rendering config for outbound text.
- `responsePrefix`: optional string prepended to outbound replies.
- `textChunkLimit`: outbound chunk size in characters when `streaming.chunkMode: "length"`. Default: `4000`.
- `streaming.chunkMode`: `"length"` (default, splits by character count) or `"newline"` (splits at line boundaries).
- `historyLimit`: number of recent room messages included as `InboundHistory` when a room message triggers the agent. Falls back to `messages.groupChat.historyLimit`; effective default `0` (disabled).
- `mediaMaxMb`: media size cap in MB for outbound sends and inbound processing. Default: `20`.

### Reaction settings

- `ackReaction`: ack reaction override for this channel/account.
- `ackReactionScope`: scope override (`"group-mentions"` default, `"group-all"`, `"direct"`, `"all"`, `"none"`, `"off"`).
- `reactionNotifications`: inbound reaction notification mode (`"own"` default, `"off"`).

### Tooling and per-room overrides

- `actions`: per-action tool gating (`messages`, `reactions`, `pins`, `profile`, `memberInfo`, `channelInfo`, `verification`).
- `groups`: per-room policy map. Session identity uses the stable room ID after resolution. (`rooms` is a legacy alias.)
  - `groups.<room>.account`: restrict one inherited room entry to a specific account.
  - `groups.<room>.enabled`: per-room toggle. When `false`, the room is ignored as if it were not in the map.
  - `groups.<room>.requireMention`: per-room override of the channel-level mention requirement.
  - `groups.<room>.allowBots`: per-room override of the channel-level setting (`true` or `"mentions"`).
  - `groups.<room>.botLoopProtection`: per-room override for bot-to-bot loop protection budget.
  - `groups.<room>.users`: per-room sender allowlist.
  - `groups.<room>.tools`: per-room tool allow/deny overrides.
  - `groups.<room>.autoReply`: per-room mention-gating override. `true` disables mention requirements for that room; `false` forces them back on.
  - `groups.<room>.skills`: per-room skill filter.
  - `groups.<room>.systemPrompt`: per-room system prompt snippet.

### Exec approval settings

- `execApprovals.enabled`: deliver exec approvals through Matrix-native prompts.
- `execApprovals.approvers`: Matrix user IDs allowed to approve. Falls back to `dm.allowFrom`.
- `execApprovals.target`: `"dm"` (default), `"channel"`, or `"both"`.
- `execApprovals.agentFilter` / `execApprovals.sessionFilter`: optional agent/session allowlists for delivery.

## Related

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Security](/gateway/security) - access model and hardening
