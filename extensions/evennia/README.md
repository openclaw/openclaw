# Evennia channel plugin prototype

Experimental OpenClaw channel plugin for bridging an OpenClaw agent account to an Evennia MUD character over Evennia's webclient WebSocket.

Current smoke-tested path:

Evennia room mention or private message → OpenClaw channel turn → in-world reply.

This is intentionally still prototype code. The long-term direction is to add structured Evennia-side bridge events rather than relying on webclient text scraping.
