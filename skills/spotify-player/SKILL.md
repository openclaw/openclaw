---
name: spotify-player
description: Terminal Spotify playback/search via spogo (preferred) or spotify_player.
homepage: https://www.spotify.com
metadata: {"openclaw":{"emoji":"🎵","requires":{"anyBins":["spogo","spotify_player"]},"install":[{"id":"brew","kind":"brew","formula":"spogo","tap":"steipete/tap","bins":["spogo"],"label":"Install spogo (brew)"},{"id":"brew","kind":"brew","formula":"spotify_player","bins":["spotify_player"],"label":"Install spotify_player (brew)"}]}}
---

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

## Embed Helper Script

Use `spotify-embed.py` to search tracks, get embed URLs, and save to ppl.gift journal.

```bash
# Search tracks (returns URLs + embed links)
python3 {baseDir}/scripts/spotify-embed.py search "Gratitude Brandon Lake"

# Get embed URL for a track ID
python3 {baseDir}/scripts/spotify-embed.py embed 4VI7berVSzuaBt1BGrBksC

# Save track to ppl.gift journal
python3 {baseDir}/scripts/spotify-embed.py journal "Gratitude Brandon Lake" "Song of the Year 2025" -m "My theme song for the year"
```

### Embed URLs
- **Open link**: `https://open.spotify.com/track/{ID}` (opens Spotify)
- **Embed link**: `https://open.spotify.com/embed/track/{ID}` (embeddable player)

### HTML Embed (ppl.gift compatible)
```html
<div style="left: 0; width: 100%; height: 80px; position: relative;">
  <iframe src="https://open.spotify.com/embed/track/{TRACK_ID}?utm_source=oembed" 
          style="top: 0; left: 0; width: 100%; height: 100%; position: absolute; border: 0;" 
          allowfullscreen allow="clipboard-write; encrypted-media; fullscreen; picture-in-picture;">
  </iframe>
</div>
```
