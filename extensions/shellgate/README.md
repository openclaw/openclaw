# Shellgate

Optional per-account Bearer authentication for an existing trusted reverse proxy.
Caddy can keep authenticating browser users with Basic auth while Shellgate
verifies separate tokens for human or service subjects. OpenClaw continues to own
profiles, roles, device pairing, and session permissions.

Enable with `openclaw plugins enable shellgate`, then follow the
[Shellgate guide](https://docs.openclaw.ai/plugins/shellgate) before exposing a route.
The plugin does not configure or start a proxy, change Gateway auth, or issue
Gateway/device tokens. Its administrative CLI talks to the running Gateway; it
never writes a second account database.
