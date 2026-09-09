---
summary: "Native iMessage support via imsg (JSON-RPC over stdio), with private API actions for replies, tapbacks, effects, polls, attachments, and group management. Preferred for new OpenClaw iMessage setups when host requirements fit."
read_when:
  - Setting up iMessage support
  - Debugging iMessage send/receive
title: "iMessage"
---

<Note>
For the usual OpenClaw iMessage deployment, run the Gateway and `imsg` on the same signed-in macOS Messages host. If your Gateway runs elsewhere, point `channels.imessage.cliPath` at a transparent SSH wrapper that runs `imsg` on the Mac.

**Inbound recovery is automatic.** After a bridge or gateway restart, iMessage replays the messages missed while it was down and suppresses the stale "backlog bomb" Apple can flush after a Push recovery, deduping so nothing is dispatched twice. There is no config to enable — see [Inbound recovery after a bridge or gateway restart](/channels/imessage/messaging#inbound-recovery-after-a-bridge-or-gateway-restart).
</Note>

<Warning>
BlueBubbles support was removed. Migrate `channels.bluebubbles` configs to `channels.imessage`; OpenClaw supports iMessage through `imsg` only. Start with [BlueBubbles removal and the imsg iMessage path](/announcements/bluebubbles-imessage) for the short announcement, or [Coming from BlueBubbles](/channels/imessage-from-bluebubbles) for the full migration table.
</Warning>

Status: native external CLI integration. The Gateway spawns `imsg rpc` and speaks JSON-RPC over stdio — no separate daemon or port. Private API mode is strongly encouraged for a complete iMessage channel; replies, tapbacks, effects, polls, attachment replies, and group actions require `imsg launch` and a successful private API probe.

For the common local setup, OpenClaw setup can offer a user-confirmed Homebrew install or update for `imsg` on the signed-in Messages Mac. Manual setup and SSH-wrapper topologies remain operator-managed: install or update `imsg` in the same user context that will run the Gateway or wrapper.

<CardGroup cols={3}>
  <Card title="Setup" icon="rocket" href="/channels/imessage/setup">
    Install the plugin, set up `imsg`, and grant the macOS permissions.
  </Card>
  <Card title="Private API" icon="wand-sparkles" href="/channels/imessage/private-api">
    Disable SIP, inject the helper, and unlock the native actions.
  </Card>
  <Card title="Troubleshooting" icon="wrench" href="/channels/imessage/troubleshooting">
    Fixes for silent inbound, ignored chats, and failed attachments.
  </Card>
</CardGroup>

## What each page covers

- [iMessage setup](/channels/imessage/setup) — install the plugin, set up `imsg` on the Messages Mac, and grant Full Disk Access and Automation.
- [Enabling the imsg private API](/channels/imessage/private-api) — the SIP and library-validation procedure, helper injection, and what stays available when SIP stays on.
- [iMessage access control and routing](/channels/imessage/access-control) — DM and group policy, mention gating, per-group prompts, ACP bindings, and config writes.
- [iMessage deployment patterns](/channels/imessage/deployment) — dedicated bot macOS user, remote Mac over Tailscale, multi-account, and DM history.
- [iMessage media and attachments](/channels/imessage/media) — attachment ingestion and staging, outbound chunking, and delivery target formats.
- [iMessage private API actions](/channels/imessage/rich-messages) — tapbacks, threaded replies, effects, native polls, approval controls, and question reactions.
- [iMessage message behavior](/channels/imessage/messaging) — split-send DM coalescing and automatic inbound recovery after a restart.
- [iMessage troubleshooting](/channels/imessage/troubleshooting) — symptom-first fixes and the configuration reference links.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/channels/imessage#troubleshooting` still resolves. Each entry points at the page that now holds the content.

- <a id="install-the-plugin" />[Install the plugin](/channels/imessage/setup#install-the-plugin)
- <a id="quick-setup" />[Quick setup](/channels/imessage/setup#quick-setup)
- <a id="requirements-and-permissions-(macos)" />[Requirements and permissions (macOS)](</channels/imessage/setup#requirements-and-permissions-(macos)>)
- <a id="enabling-the-imsg-private-api" />[Enabling the imsg private API](/channels/imessage/private-api#enabling-the-imsg-private-api)
- <a id="setup" />[Setup](/channels/imessage/private-api#setup)
- <a id="when-sip-stays-enabled" />[When SIP stays enabled](/channels/imessage/private-api#when-sip-stays-enabled)
- <a id="access-control-and-routing" />[Access control and routing](/channels/imessage/access-control#access-control-and-routing)
- <a id="acp-conversation-bindings" />[ACP conversation bindings](/channels/imessage/access-control#acp-conversation-bindings)
- <a id="deployment-patterns" />[Deployment patterns](/channels/imessage/deployment#deployment-patterns)
- <a id="media%2C-chunking%2C-and-delivery-targets" />[Media, chunking, and delivery targets](/channels/imessage/media#media%2C-chunking%2C-and-delivery-targets)
- <a id="private-api-actions" />[Private API actions](/channels/imessage/rich-messages#private-api-actions)
- <a id="config-writes" />[Config writes](/channels/imessage/access-control#config-writes)
- <a id="coalescing-split-send-dms-command--url-in-one-composition" />[Coalescing split-send DMs (command + URL in one composition)](/channels/imessage/messaging#coalescing-split-send-dms-command--url-in-one-composition)
- <a id="coalescing-split-send-dms-(command-%2B-url-in-one-composition)" />[Coalescing split-send DMs (command + URL in one composition)](</channels/imessage/messaging#coalescing-split-send-dms-(command-%2B-url-in-one-composition)>)
- <a id="inbound-recovery-after-a-bridge-or-gateway-restart" />[Inbound recovery after a bridge or gateway restart](/channels/imessage/messaging#inbound-recovery-after-a-bridge-or-gateway-restart)
- <a id="operator-visible-signal" />[Operator-visible signal](/channels/imessage/messaging#operator-visible-signal)
- <a id="migration" />[Migration](/channels/imessage/messaging#migration)
- <a id="troubleshooting" />[Troubleshooting](/channels/imessage/troubleshooting#troubleshooting)
- <a id="configuration-reference-pointers" />[Configuration reference pointers](/channels/imessage/troubleshooting#configuration-reference-pointers)
- <a id="requirements-and-permissions-macos" />[Requirements and permissions (macOS)](/channels/imessage/setup#requirements-and-permissions-macos)
- <a id="media-chunking-and-delivery-targets" />[Media, chunking, and delivery targets](/channels/imessage/media#media-chunking-and-delivery-targets)
- <a id="coalescing-split-send-dms-command-+-url-in-one-composition" />[Coalescing split-send DMs (command + URL in one composition)](/channels/imessage/messaging#coalescing-split-send-dms-command-+-url-in-one-composition)
- <a id="local-mac-fast-path" />[Local Mac (fast path)](/channels/imessage/setup#local-mac-fast-path)
- <a id="install-and-verify-imsg" />[Install and verify imsg](/channels/imessage/setup#install-and-verify-imsg)
- <a id="configure-openclaw" />[Configure OpenClaw](/channels/imessage/setup#configure-openclaw)
- <a id="start-gateway" />[Start gateway](/channels/imessage/setup#start-gateway)
- <a id="approve-first-dm-pairing-default-dmpolicy" />[Approve first DM pairing (default dmPolicy)](/channels/imessage/setup#approve-first-dm-pairing-default-dmpolicy)
- <a id="remote-mac-over-ssh" />[Remote Mac over SSH](/channels/imessage/setup#remote-mac-over-ssh)
- <a id="ssh-wrapper-sends-fail-with-appleevents-1743" />[SSH wrapper sends fail with AppleEvents -1743](/channels/imessage/setup#ssh-wrapper-sends-fail-with-appleevents-1743)
- <a id="dm-policy" />[DM policy](/channels/imessage/access-control#dm-policy)
- <a id="group-policy-%2B-mentions" />[Group policy + mentions](/channels/imessage/access-control#group-policy-%2B-mentions)
- <a id="sessions-and-deterministic-replies" />[Sessions and deterministic replies](/channels/imessage/access-control#sessions-and-deterministic-replies)
- <a id="dedicated-bot-macos-user-separate-imessage-identity" />[Dedicated bot macOS user (separate iMessage identity)](/channels/imessage/deployment#dedicated-bot-macos-user-separate-imessage-identity)
- <a id="remote-mac-over-tailscale-example" />[Remote Mac over Tailscale (example)](/channels/imessage/deployment#remote-mac-over-tailscale-example)
- <a id="multi-account-pattern" />[Multi-account pattern](/channels/imessage/deployment#multi-account-pattern)
- <a id="direct-message-history" />[Direct-message history](/channels/imessage/deployment#direct-message-history)
- <a id="attachments-and-media" />[Attachments and media](/channels/imessage/media#attachments-and-media)
- <a id="outbound-text-and-chunking" />[Outbound text and chunking](/channels/imessage/media#outbound-text-and-chunking)
- <a id="addressing-formats" />[Addressing formats](/channels/imessage/media#addressing-formats)
- <a id="available-actions" />[Available actions](/channels/imessage/rich-messages#available-actions)
- <a id="message-ids" />[Message IDs](/channels/imessage/rich-messages#message-ids)
- <a id="capability-detection" />[Capability detection](/channels/imessage/rich-messages#capability-detection)
- <a id="read-receipts-and-typing" />[Read receipts and typing](/channels/imessage/rich-messages#read-receipts-and-typing)
- <a id="inbound-tapbacks" />[Inbound tapbacks](/channels/imessage/rich-messages#inbound-tapbacks)
- <a id="approval-polls-and-reactions" />[Approval polls and reactions](/channels/imessage/rich-messages#approval-polls-and-reactions)
- <a id="question-reactions-1-2-3-4" />[Question reactions (1️⃣ / 2️⃣ / 3️⃣ / 4️⃣)](/channels/imessage/rich-messages#question-reactions-1-2-3-4)
- <a id="imsg-not-found-or-rpc-unsupported" />[imsg not found or RPC unsupported](/channels/imessage/troubleshooting#imsg-not-found-or-rpc-unsupported)
- <a id="messages-send-but-inbound-imessages-do-not-arrive" />[Messages send but inbound iMessages do not arrive](/channels/imessage/troubleshooting#messages-send-but-inbound-imessages-do-not-arrive)
- <a id="gateway-is-not-running-on-macos" />[Gateway is not running on macOS](/channels/imessage/troubleshooting#gateway-is-not-running-on-macos)
- <a id="dms-are-ignored" />[DMs are ignored](/channels/imessage/troubleshooting#dms-are-ignored)
- <a id="group-messages-are-ignored" />[Group messages are ignored](/channels/imessage/troubleshooting#group-messages-are-ignored)
- <a id="remote-attachments-fail" />[Remote attachments fail](/channels/imessage/troubleshooting#remote-attachments-fail)
- <a id="macos-permission-prompts-were-missed" />[macOS permission prompts were missed](/channels/imessage/troubleshooting#macos-permission-prompts-were-missed)

## Related

<CardGroup cols={2}>
  <Card title="Channels Overview" icon="list" href="/channels">
    All supported channels.
  </Card>
  <Card title="Coming from BlueBubbles" icon="right-left" href="/channels/imessage-from-bluebubbles">
    Config translation table and step-by-step cutover.
  </Card>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    DM authentication and pairing flow.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Group chat behavior and mention gating.
  </Card>
  <Card title="Channel Routing" icon="route" href="/channels/channel-routing">
    Session routing for messages.
  </Card>
  <Card title="Configuration reference" icon="sliders" href="/gateway/config-channels#imessage">
    Full iMessage field reference.
  </Card>
</CardGroup>
