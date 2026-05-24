# Evennia channel plugin prototype

Experimental OpenClaw channel plugin for bridging an OpenClaw agent account to an Evennia MUD character over Evennia's webclient WebSocket.

Current smoke-tested paths:

- Evennia room mention or private message → OpenClaw channel turn → in-world reply.
- OpenClaw tool call → one raw Evennia command sent as the configured character, with the immediate in-world text response returned in the tool result.

This is intentionally still prototype code. The long-term direction is to add structured Evennia-side bridge events rather than relying on webclient text scraping.

Development happens from Patrick's host checkout only. Do not give Scoob/Dumbledong Patrick's GitHub credentials or writable remotes for this plugin; see `DEVELOPMENT.md` for the safe deploy workflow.

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

Command output is collected briefly from the Evennia webclient WebSocket and returned as `output` in the tool result, so the agent can inspect rooms, containers, and NPC replies before deciding the next action. If Evennia produces no immediate text, the tool still succeeds and returns an empty `output` plus a note.
