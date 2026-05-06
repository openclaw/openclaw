---
summary: "Switch from the BlueBubbles plugin to the bundled iMessage plugin without losing pairing, allowlists, or group bindings."
read_when:
  - Planning a move from BlueBubbles to the bundled iMessage plugin
  - Translating BlueBubbles config keys to iMessage equivalents
  - Rolling back a partial iMessage cutover
title: "Coming from BlueBubbles"
---

The bundled `imessage` plugin now reaches the same private API surface as BlueBubbles (`react`, `edit`, `unsend`, `reply`, `sendWithEffect`, group management, attachments) by driving [`steipete/imsg`](https://github.com/steipete/imsg) over JSON-RPC. If you already run a Mac with `imsg` installed, you can drop the BlueBubbles server and let the plugin talk to Messages.app directly.

This guide is opt-in. BlueBubbles still works and remains the right choice if you cannot run `imsg` on the host where the Mac signs into iMessage (for example, if the Mac is unreachable from the gateway).

## When this migration makes sense

- You already run `imsg` on the same Mac (or one reachable over SSH) where Messages.app is signed in.
- You want one fewer moving part — no separate BlueBubbles server, no REST endpoint to authenticate, no webhook plumbing.
- You are on a [supported macOS / `imsg` build](/channels/imessage#requirements-and-permissions-macos) where the private API probe reports `available: true`.

## When to stay on BlueBubbles

- The Mac with Messages.app is on a network the gateway cannot reach via SSH.
- You depend on BlueBubbles features the bundled plugin does not yet cover (rich text formatting attributes beyond bold/italic/underline/strikethrough, BlueBubbles-specific webhook integrations).
- Your current setup hard-codes BlueBubbles webhook URLs into other systems that you cannot rewire.

## Before you start

1. Install `imsg` on the Mac that runs Messages.app:

   ```bash
   brew install steipete/tap/imsg
   imsg launch
   imsg rpc --help
   ```

2. Verify the private API bridge:

   ```bash
   openclaw channels status --probe
   ```

   You want `imessage.privateApi.available: true`. If it reports `false`, fix that first — see [Capability detection](/channels/imessage#private-api-actions).

3. Snapshot your config so you can roll back:

   ```bash
   cp ~/.openclaw/openclaw.json5 ~/.openclaw/openclaw.json5.bak
   ```

## Config translation

iMessage and BlueBubbles share a lot of channel-level config. The keys that change are mostly transport (REST server vs local CLI). Behavior keys (`dmPolicy`, `groupPolicy`, `allowFrom`, etc.) keep the same meaning.

| BlueBubbles                                                | bundled iMessage                          | Notes                                                                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels.bluebubbles.enabled`                             | `channels.imessage.enabled`               | Same semantics.                                                                                                                                                                     |
| `channels.bluebubbles.serverUrl`                           | _(removed)_                               | No REST server — the plugin spawns `imsg rpc` over stdio.                                                                                                                           |
| `channels.bluebubbles.password`                            | _(removed)_                               | No webhook authentication needed.                                                                                                                                                   |
| _(implicit)_                                               | `channels.imessage.cliPath`               | Path to `imsg` (default `imsg`); use a wrapper script for SSH.                                                                                                                      |
| _(implicit)_                                               | `channels.imessage.dbPath`                | Optional Messages.app `chat.db` override; auto-detected when omitted.                                                                                                               |
| _(implicit)_                                               | `channels.imessage.remoteHost`            | `host` or `user@host` — only needed when `cliPath` is an SSH wrapper and you want SCP attachment fetches.                                                                           |
| `channels.bluebubbles.dmPolicy`                            | `channels.imessage.dmPolicy`              | Same values (`pairing` / `allowlist` / `open` / `disabled`).                                                                                                                        |
| `channels.bluebubbles.allowFrom`                           | `channels.imessage.allowFrom`             | Pairing approvals carry over by handle, not by token.                                                                                                                               |
| `channels.bluebubbles.groupPolicy`                         | `channels.imessage.groupPolicy`           | Same values (`allowlist` / `open` / `disabled`).                                                                                                                                    |
| `channels.bluebubbles.groupAllowFrom`                      | `channels.imessage.groupAllowFrom`        | Same.                                                                                                                                                                               |
| `channels.bluebubbles.groups`                              | `channels.imessage.groups`                | Per-group `requireMention`, `tools`, `toolsBySender` carry over verbatim.                                                                                                           |
| `channels.bluebubbles.sendReadReceipts`                    | `channels.imessage.sendReadReceipts`      | Default `true`. With the bundled plugin this only fires when the private API probe is up.                                                                                           |
| `channels.bluebubbles.includeAttachments`                  | `channels.imessage.includeAttachments`    | Same.                                                                                                                                                                               |
| `channels.bluebubbles.attachmentRoots`                     | `channels.imessage.attachmentRoots`       | Local roots; same wildcard rules.                                                                                                                                                   |
| _(N/A)_                                                    | `channels.imessage.remoteAttachmentRoots` | Only used when `remoteHost` is set for SCP fetches.                                                                                                                                 |
| `channels.bluebubbles.mediaMaxMb`                          | `channels.imessage.mediaMaxMb`            | Default 16 MB on iMessage (BlueBubbles default was 8 MB). Set explicitly if you want to keep the lower cap.                                                                         |
| `channels.bluebubbles.textChunkLimit`                      | `channels.imessage.textChunkLimit`        | Default 4000 on both.                                                                                                                                                               |
| `channels.bluebubbles.coalesceSameSenderDms`               | _(not yet)_                               | Same-sender DM coalescing is BlueBubbles-only at time of writing.                                                                                                                   |
| `channels.bluebubbles.enrichGroupParticipantsFromContacts` | _(N/A)_                                   | iMessage already reads sender display names from `chat.db`.                                                                                                                         |
| `channels.bluebubbles.actions.*`                           | `channels.imessage.actions.*`             | Per-action toggles: `reactions`, `edit`, `unsend`, `reply`, `sendWithEffect`, `renameGroup`, `setGroupIcon`, `addParticipant`, `removeParticipant`, `leaveGroup`, `sendAttachment`. |

Multi-account configs (`channels.bluebubbles.accounts.*`) translate one-to-one to `channels.imessage.accounts.*`.

## Step-by-step

1. Add an iMessage block alongside the existing BlueBubbles block. Do not delete BlueBubbles yet:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         // ... existing config ...
       },
       imessage: {
         enabled: false, // turn on after the dry run below
         cliPath: "/opt/homebrew/bin/imsg",
         dmPolicy: "pairing",
         allowFrom: ["+15555550123"], // copy from bluebubbles.allowFrom
         groupPolicy: "allowlist",
         groupAllowFrom: [], // copy from bluebubbles.groupAllowFrom
         actions: {
           reactions: true,
           edit: true,
           unsend: true,
           reply: true,
           sendWithEffect: true,
           sendAttachment: true,
         },
       },
     },
   }
   ```

2. **Dry-run probe** — start the gateway and confirm both channels report healthy:

   ```bash
   openclaw gateway
   openclaw channels status
   openclaw channels status --probe   # expect imessage.privateApi.available: true
   ```

   Because `imessage.enabled` is still `false`, no inbound iMessage traffic is routed yet — but `--probe` exercises the bridge so you catch permission/install issues before the cutover.

3. **Cut over.** Disable BlueBubbles and enable iMessage in one config edit:

   ```json5
   {
     channels: {
       bluebubbles: { enabled: false }, // keep the rest of the block for rollback
       imessage: { enabled: true /* ... */ },
     },
   }
   ```

   Restart the gateway. Inbound iMessage traffic now flows through the bundled plugin.

4. **Verify the action surface** — from a paired DM, ask the agent to react, edit, unsend, reply, send a photo, and (in a group) rename the group / add or remove a participant. Each action should land natively in Messages.app. If any throws "iMessage `<action>` requires the imsg private API bridge", run `imsg launch` again and refresh `channels status --probe`.

5. **Stop the BlueBubbles server** once you have run on iMessage for at least a few hours of normal traffic. Remove the BlueBubbles block from config and restart the gateway.

## Action parity at a glance

| Action                                              | BlueBubbles | bundled iMessage                                                              |
| --------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| Send text / SMS fallback                            | ✅          | ✅                                                                            |
| Send media (photo, video, file, voice)              | ✅          | ✅                                                                            |
| Threaded reply (`reply_to_guid`)                    | ✅          | ✅ (closes [#51892](https://github.com/openclaw/openclaw/issues/51892))       |
| Tapback (`react`)                                   | ✅          | ✅                                                                            |
| Edit / unsend (macOS 13+ recipients)                | ✅          | ✅                                                                            |
| Send with screen effect                             | ✅          | ✅ (closes part of [#9394](https://github.com/openclaw/openclaw/issues/9394)) |
| Rich text bold / italic / underline / strikethrough | ✅          | ✅ (typed-run formatting via attributedBody)                                  |
| Rename group / set group icon                       | ✅          | ✅                                                                            |
| Add / remove participant, leave group               | ✅          | ✅                                                                            |
| Read receipts and typing indicator                  | ✅          | ✅ (gated on private API probe)                                               |
| Same-sender DM coalescing                           | ✅          | _(not yet)_                                                                   |

## Pairing, sessions, and ACP bindings

- **Pairing approvals** carry over by handle. You do not need to re-approve known senders — `channels.imessage.allowFrom` recognizes the same `+15555550123` / `user@example.com` strings BlueBubbles used.
- **Sessions** stay scoped per agent + chat. DMs collapse into the agent main session under default `session.dmScope=main`; group sessions stay isolated per `chat_id`. The session keys differ (`agent:<id>:imessage:group:<chat_id>` vs the BlueBubbles equivalent) — old conversation history under BlueBubbles session keys does not carry into iMessage sessions.
- **ACP bindings** referencing `match.channel: "bluebubbles"` need to be updated to `"imessage"`. The `match.peer.id` shapes (`chat_id:`, `chat_guid:`, `chat_identifier:`, bare handle) are identical.

## Running both at once

You can keep both `bluebubbles` and `imessage` enabled during cutover testing. BlueBubbles' manifest still declares `preferOver: ["imessage"]`, so the auto-enable resolver continues to prefer BlueBubbles when both channels are configured — the bundled iMessage plugin will not pick up traffic until BlueBubbles is disabled (`channels.bluebubbles.enabled: false`) or removed from config.

If you want both channels to run simultaneously instead of in cutover mode, that is not currently supported through plugin auto-enable; use one channel at a time.

## Rollback

Because you kept the BlueBubbles config block:

1. Set `channels.bluebubbles.enabled: true` and `channels.imessage.enabled: false`.
2. Restart the gateway.
3. Inbound traffic returns to BlueBubbles. Reply caches and ACP bindings on the iMessage side stay on disk under `~/.openclaw/state/imessage/` and resume cleanly if you re-enable later.

The reply cache lives at `~/.openclaw/state/imessage/reply-cache.jsonl` (mode `0600`, parent dir `0700`). It is safe to delete if you want a clean slate.

## Related

- [iMessage](/channels/imessage) — full iMessage channel reference, including `imsg launch` setup and capability detection.
- [BlueBubbles](/channels/bluebubbles) — full BlueBubbles channel reference for the legacy path.
- [Pairing](/channels/pairing) — DM authentication and pairing flow.
- [Channel Routing](/channels/channel-routing) — how the gateway picks a channel for outbound replies.
