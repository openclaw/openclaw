---
summary: "The commands.* block: native and text command surfaces, bash, config writes, and owner allowlists"
read_when:
  - Enabling or disabling a chat command surface
  - Restricting who may run commands on a channel
  - Auditing `/config`, `/mcp`, `/plugins`, or `!` bash access
title: "Configuration — chat commands"
---

The `commands.*` block: which chat command surfaces are registered, and who may use them.

## Commands (chat command handling)

```json5
{
  commands: {
    native: "auto", // register native commands when supported
    nativeSkills: "auto", // register native skill commands when supported
    text: true, // parse /commands in chat messages
    bash: false, // allow ! (alias: /bash)
    bashForegroundMs: 2000,
    config: false, // allow /config
    mcp: false, // allow /mcp
    plugins: false, // allow /plugins
    debug: false, // allow /debug
    restart: true, // allow /restart + external SIGUSR1 restart requests
    ownerAllowFrom: ["discord:123456789012345678"],
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
  },
}
```

<Accordion title="Command details">

- This block configures command surfaces. For the current built-in + bundled command catalog, see [Slash Commands](/tools/slash-commands).
- This page is a **config-key reference**, not the full command catalog. Channel/plugin-owned commands such as QQ Bot `/bot-ping` `/bot-help` `/bot-logs`, LINE `/card`, device-pair `/pair`, memory `/dreaming`, and Talk `/voice` are documented in their channel/plugin pages plus [Slash Commands](/tools/slash-commands).
- Text commands must be **standalone** messages with leading `/`.
- `native: "auto"` turns on native commands for Discord/Telegram, leaves Slack off.
- `nativeSkills: "auto"` turns on native skill commands for Discord/Telegram, leaves Slack off.
- Override per channel: `channels.discord.commands.native` (bool or `"auto"`). For Discord, `false` skips native command registration and cleanup during startup.
- Override native skill registration per channel with `channels.<provider>.commands.nativeSkills`.
- `channels.telegram.customCommands` adds extra Telegram bot menu entries.
- `bash: true` enables `! <cmd>` for host shell. Requires `tools.elevated.enabled` and sender in `tools.elevated.allowFrom.<channel>`.
- `config: true` enables `/config` (reads/writes `openclaw.json`). For gateway `chat.send` clients, persistent `/config set|unset` writes also require `operator.admin`; read-only `/config show` stays available to normal write-scoped operator clients.
- `mcp: true` enables `/mcp` for OpenClaw-managed MCP server config under `mcp.servers`.
- `plugins: true` enables `/plugins` for plugin discovery, install, and enable/disable controls.
- `channels.<provider>.configWrites` gates config mutations per channel (default: true).
- For multi-account channels, `channels.<provider>.accounts.<id>.configWrites` also gates writes that target that account (for example `/allowlist --config --account <id>` or `/config set channels.<provider>.accounts.<id>...`).
- `restart: false` disables `/restart` and external `SIGUSR1` restart requests. Default: `true`.
- `ownerAllowFrom` is the explicit owner allowlist for owner-only commands and owner-gated channel actions. It is separate from `allowFrom`.
- `allowFrom` is per-provider. When set, it is the **only** authorization source for commands and directives.
- When `allowFrom` is unset, command authorization follows channel allowlists and pairing state. Access-group entries in channel allowlists are resolved automatically.
- Command docs map:
  - built-in + bundled catalog: [Slash Commands](/tools/slash-commands)
  - channel-specific command surfaces: [Channels](/channels)
  - QQ Bot commands: [QQ Bot](/channels/qqbot)
  - pairing commands: [Pairing](/channels/pairing)
  - LINE card command: [LINE](/channels/line)
  - memory dreaming: [Dreaming](/concepts/dreaming)

</Accordion>
