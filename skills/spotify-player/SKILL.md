---
name: spotify-player
description: Terminal Spotify client (TUI + CLI commands) for playback and search.
metadata: {"clawdis":{"requires":{"bins":["spotify_player"]},"install":[{"id":"brew","kind":"brew","formula":"spotify_player","bins":["spotify_player"],"label":"Install spotify-player (brew)"}]}}
---

# spotify_player

Use `spotify_player` for Spotify playback/search in the terminal.

Requirements
- Spotify Premium account.
- First-time auth: `spotify_player authenticate`.

Common CLI commands
- Search: `spotify_player search "query"`
- Playback: `spotify_player playback play|pause|next|previous`
- Connect device: `spotify_player connect`
- Like track: `spotify_player like`

Notes
- Config folder: `~/.config/spotify-player` (e.g., `app.toml`).
- For Spotify Connect integration, set a user `client_id` in config.
- TUI shortcuts are available via `?` in the app.
