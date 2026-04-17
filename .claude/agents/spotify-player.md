---
name: spotify-player
description: Terminal Spotify playback/search via spogo (preferred) or spotify_player.
---
## Requirements


### Install

- **Install spogo (brew)** — formula `spogo`
- **Install spotify_player (brew)** — formula `spotify_player`

## Homepage

- https://www.spotify.com

# spogo / spotify_player

Use `spogo` **(preferred)** for Spotify playback/search. Fall back to `spotify_player` if needed.

Requirements

- Spotify Premium account.
- Either `spogo` or `spotify_player` installed.

spogo setup

- Import cookies: `spogo auth import --browser chrome`

Common CLI commands

- Search: `spogo search track "query"`
- Playback: `spogo play|pause|next|prev`
- Devices: `spogo device list`, `spogo device set "<name|id>"`
- Status: `spogo status`

spotify_player commands (fallback)

- Search: `spotify_player search "query"`
- Playback: `spotify_player playback play|pause|next|previous`
- Connect device: `spotify_player connect`
- Like track: `spotify_player like`

Notes

- Config folder: `~/.config/spotify-player` (e.g., `app.toml`).
- For Spotify Connect integration, set a user `client_id` in config.
- TUI shortcuts are available via `?` in the app.
