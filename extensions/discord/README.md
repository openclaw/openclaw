# OpenClaw Discord

Official OpenClaw channel plugin for Discord servers, channels, DMs, slash commands, and app events.

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
