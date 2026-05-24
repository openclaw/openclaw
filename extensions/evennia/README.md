# Evennia channel plugin prototype

Experimental OpenClaw channel plugin for bridging an OpenClaw agent account to an Evennia MUD character over Evennia's webclient WebSocket.

Current smoke-tested paths:

- Evennia room mention or private message → OpenClaw channel turn → in-world reply.
- OpenClaw tool call → one raw Evennia command sent as the configured character.

This is intentionally still prototype code. The long-term direction is to add structured Evennia-side bridge events rather than relying on webclient text scraping.

## Command tool

The plugin registers `evennia_command`, a generic tool that sends one raw command to Evennia as a configured character. Evennia remains the authority for permissions, custom commands, admin powers, and game effects; the plugin does not maintain a separate command allowlist or admin switch.

Make sure the runtime tool policy exposes the tool to the agent. For example, when using the `coding` tool profile:

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["evennia_command"]
  }
}
```

The Evennia channel adds turn-level prompt guidance telling the agent to use `evennia_command` for in-world actions instead of saying command strings aloud.

The only transport-level checks are:

- `command` must be non-empty
- `command` must not contain newlines, so each tool call maps to one Evennia command

Command output is delivered through the normal Evennia channel/event stream rather than synchronously returned by the tool.
