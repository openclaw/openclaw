# Evennia channel plugin prototype

Experimental OpenClaw channel plugin for bridging an OpenClaw agent account to an Evennia MUD character over Evennia's webclient WebSocket.

Current smoke-tested path:

Evennia room mention or private message → OpenClaw channel turn → in-world reply.

This is intentionally still prototype code. The long-term direction is to add structured Evennia-side bridge events rather than relying on webclient text scraping.

## Optional autonomy loop

Accounts may enable a small, transport-local autonomy loop. It only sends configured Evennia commands over the existing Evennia websocket; it does not grant shell, web, messaging, or other OpenClaw tools. Keep command lists narrow and game-safe.

Example account config:

```json
{
  "autonomy": {
    "enabled": true,
    "intervalMs": 90000,
    "idleChance": 0.6,
    "commands": ["look", "pose studies the room"]
  }
}
```
