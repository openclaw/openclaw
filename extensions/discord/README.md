# OpenClaw Discord

Official OpenClaw channel plugin for Discord servers, channels, DMs, slash commands, and app events.

Voice input has a packet-inactivity deadline even when a speaker disconnects
without a speaking-end event. `voice.captureSilenceGraceMs` still controls the
grace after the SDK detects silence. Active recordings flush
bounded WAV segments to disk; stream errors discard the incomplete segment and
release the speaker subscription. Continuous capture remains registered.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/discord
```

Configure a Discord bot token and the channels or servers OpenClaw should handle. The plugin lets OpenClaw agents receive Discord messages and respond through the configured Discord app.

Configurations using pre-July-2026 `voice.tts.<provider>` keys or per-channel
`allow`/`agentId` fields require an intermediate upgrade. Install OpenClaw
`2026.9.7` and run `openclaw doctor --fix` before upgrading again. Current Doctor
preserves these old settings and reports the exact path instead of rewriting
them. Supported configurations use `voice.tts.providers`, channel `enabled`,
and top-level `bindings`.

## Forking a conversation

Run `/fork [title]` inside an existing server text thread or forum post to copy the
OpenClaw conversation into a new sibling under the same parent channel. The
source stays bound to its original session. The new thread is bound to the copied
ordinary session, and receives a short text-only recap with Discord mentions
neutralized. A Discord jump link points to the sibling; it never grants access.
Names are limited to Discord's 100-character thread-name limit. Forum siblings
reuse available source tags, including the forum's required-tag constraint.

Private threads stay private. The bot creates a non-invitable sibling, adds only
the requester, and confirms their access before binding and recap delivery.
Other source members are not automatically included. Members with Discord's
Manage Threads permission may still have access under Discord's normal rules.
There is no public fallback and no invitation link.

DMs, unthreaded channels, announcement threads, and media-channel posts are not
supported. The bot needs View Channel, Read Message History, Send Messages in
Threads, and the applicable Create Public Threads, Create Private Threads, or
forum Send Messages permission. Thread bindings must be enabled for the bot
account; existing account and command authorization still applies. This adds no
new configuration or migration requirement for existing installations. The
requester must be able to view the source and parent and read the source message
history; a visible channel alone does not grant historical context access.

If creation has an uncertain outcome, OpenClaw does not retry it automatically.
Inspect the parent channel before running the command again. When Discord returns
a sibling identity but membership or binding setup fails, the error includes its
jump link and no recap is sent. The sibling is preserved rather than silently
creating another one or deleting native work.
