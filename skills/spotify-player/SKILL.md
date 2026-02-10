---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: spotify-player（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Terminal Spotify playback/search via spogo (preferred) or spotify_player.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://www.spotify.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🎵",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "anyBins": ["spogo", "spotify_player"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "spogo",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "tap": "steipete/tap",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["spogo"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install spogo (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "spotify_player",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["spotify_player"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install spotify_player (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# spogo / spotify_player（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `spogo` **(preferred)** for Spotify playback/search. Fall back to `spotify_player` if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Spotify Premium account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Either `spogo` or `spotify_player` installed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
spogo setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Import cookies: `spogo auth import --browser chrome`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common CLI commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Search: `spogo search track "query"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Playback: `spogo play|pause|next|prev`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Devices: `spogo device list`, `spogo device set "<name|id>"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status: `spogo status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
spotify_player commands (fallback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Search: `spotify_player search "query"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Playback: `spotify_player playback play|pause|next|previous`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Connect device: `spotify_player connect`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Like track: `spotify_player like`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config folder: `~/.config/spotify-player` (e.g., `app.toml`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For Spotify Connect integration, set a user `client_id` in config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI shortcuts are available via `?` in the app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
