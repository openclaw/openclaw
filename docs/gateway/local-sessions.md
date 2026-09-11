---
summary: "Show your local Codex and Claude Code sessions on the team Gateway, live, and let teammates send into them while everything keeps running on your laptop"
title: "Live Local Sessions"
sidebarTitle: "Live Local Sessions"
read_when: "You want teammates to watch or steer a coding session that runs in your own terminal, or you are deciding between live local sessions, Cloud Sessions, session catalogs, and Beam."
status: active
doc-schema-version: 1
---

A live local session is a Codex or Claude Code session that runs in your own terminal, on your own laptop, with your own credentials and tools, and also appears as an ordinary session on the shared team Gateway. Teammates open it from the sidebar, read it as it happens, and send messages into it. The Gateway is a shared window and inbox: it never runs the turn, never holds your provider credentials, and never touches your files.

This is the team-Gateway counterpart of Claude Code Remote Control and Codex remote control. Those connect your local session to claude.ai or chatgpt.com for you alone; a live local session connects it to the Gateway your team already shares.

## How it compares

| Surface                                                      | Who runs the turn               | Live   | Teammates can send               | Credentials live on |
| ------------------------------------------------------------ | ------------------------------- | ------ | -------------------------------- | ------------------- |
| Ordinary shared session                                      | Gateway                         | yes    | yes                              | Gateway             |
| [Cloud Session](/gateway/cloud-sessions)                     | Paired device or worker         | yes    | yes                              | Gateway             |
| [Session catalog](/nodes#codex-sessions-and-transcripts) row | Nobody (read) or a Gateway copy | polled | copies into a Gateway session    | Gateway             |
| [Beam](/plugins/beam)                                        | Nobody (snapshot)               | no     | copies into a Gateway session    | Gateway             |
| **Live local session**                                       | **Your laptop's harness**       | yes    | yes, into the same native thread | **Your laptop**     |

## Before you begin

- The laptop is paired with the Gateway as a node: `openclaw connect <join-url> --service` (see [Connect](/cli/connect)) or the macOS app in node mode. The Gateway approves the node's command surface once when the local session commands first appear.
- The Codex plugin is enabled on both the Gateway and the laptop for Codex sessions. Claude Code sessions use the bundled Anthropic plugin.
- The Gateway is on a build with agent database schema 20 or later. Older builds refuse the database rather than run these sessions on the Gateway; see [Database schemas](/reference/database-schemas#live-local-session-fence-version-20).

## Share a source

Sharing is per source (Codex or Claude Code) per device, and it is a two-step consent: a teammate asks on the Gateway, the laptop owner confirms on the laptop.

1. In the Control UI, open **Devices**, select the laptop, and choose **Share Codex sessions** or **Share Claude Code sessions**. Pick the agent whose sidebar will list the sessions. The request is bound to your signed-in profile; on a Gateway that uses a shared token without roles, it is bound to the Gateway owner profile.
2. On the laptop, list the request and accept it:

```bash
openclaw sessions share
openclaw sessions share --accept <enrollmentId>
```

### The one-step way: from your profile

Open **Profile** on the Gateway and choose **Connect my laptop**. Pick the
sources to share (Codex, Claude Code) and the agent, and the page mints a
single-use command such as:

```bash
npx openclaw connect https://gateway.example/j/<shortcode> --share codex --share-request <id>
```

Paste it on your laptop. Pairing, the sharing enrollment under your profile,
and the device-side consent all happen from that one command; nothing else to
approve. The link expires with the pairing setup (about ten minutes) and can be
used once. Your shared devices and a **Stop sharing** action stay on the same
Profile page.

The node host delivers the decision within a few seconds while it is connected. From then on every future session in that source on that device is published automatically; sessions that existed before are published too when the harness still has them loaded. Use **Stop sharing** on the Profile or Devices page to revoke the whole source, or **Stop sharing this session** in a session's menu to keep one thread off the Gateway for good. Either way the mirrored sessions are deleted from the Gateway, transcript included; the originals stay on your laptop, and nothing is projected again unless you share anew. An admin who replaces your share with their own stops it the same way. Sharing the same source again into a different agent also removes the copies in the previous agent. A connect link never takes over a source someone else already shares from that device, nor moves your own share to another agent; do that from the Profile or Devices page.

Accepting means teammates who can send into the session drive your local tools with your local permissions. Approval prompts stay on your terminal.

### Codex

The Codex adapter watches the local Codex app-server daemon. Start Codex so it attaches to that daemon; the dependable form is:

```bash
codex app-server daemon start
codex --remote unix://
```

Plain `codex` also attaches when the daemon is running and no `-c` overrides are set. A session that is not attached to the daemon shows as view only on the Gateway with the fix in its status. Teammate messages arrive with the sender's name in the message and appear in your terminal as ordinary user turns once Codex commits them.

Queue modes: **steer** starts a turn when Codex is idle and steers the active turn otherwise; **followup** queues the message for after the current turn.

### Claude Code

The Claude Code adapter tails the session transcripts Claude Code writes and receives team messages through a Claude Code channel. Enable it once per laptop:

```bash
claude mcp add --scope user openclaw -- node <openclaw-dist>/extensions/anthropic/claude-channel/openclaw-channel-server.mjs
claude --dangerously-load-development-channels server:openclaw
```

and install the lifecycle hooks the plugin ships (`extensions/anthropic/claude-channel/hooks.json`) into your Claude settings. Channels are a Claude Code research preview; the development flag stays visible on purpose. Messages are delivered at the next turn boundary and Claude Code does not acknowledge consumption, so the Gateway shows them as **submitted** until the mirrored transcript record arrives. Only **followup** is available.

## What teammates see

- The session appears in the sidebar under the enrolled agent with a source badge and the owner. It is owned by the sharing person; teammates who send become participants.
- The transcript shows user turns, assistant text, and tool calls and results (collapsed). Earlier history that stayed on the laptop is marked as such.
- The composer is enabled while the device and source are connected and the harness accepts input. Every message ends in a visible receipt: accepted, submitted, committed, or rejected with the reason.
- When the laptop goes offline the row shows **device is offline** and new messages are rejected rather than queued. Nothing already accepted by the local harness is resent.

## What the Gateway cannot do

Live local session rows never enter Gateway execution. `sessions.compact`, `sessions.rewind`, `sessions.fork`, `sessions.reset`, cron, and heartbeat runs fail with a message pointing at the device. Attachments and remote approvals are not available yet.

## Related

- [Cloud Sessions](/gateway/cloud-sessions) when the Gateway should own the session and only execution moves.
- [Nodes](/nodes) for pairing, command approval, and the paired-node session catalogs.
- [Multi-user mode](/concepts/multi-user) for ownership and participants.
