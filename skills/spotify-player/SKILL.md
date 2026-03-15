---
name: spotify-player
description: "Spotify playback, search, and library management via spogo or spotify_player CLI. Use when: user asks to play music, search songs/artists/playlists, control playback, or check what's playing. NOT for: downloading music, editing audio files, or non-Spotify services."
homepage: https://www.spotify.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🎵",
        "requires": { "anyBins": ["spogo", "spotify_player"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "spogo",
              "tap": "steipete/tap",
              "bins": ["spogo"],
              "label": "Install spogo (brew)",
            },
            {
              "id": "brew",
              "kind": "brew",
              "formula": "spotify_player",
              "bins": ["spotify_player"],
              "label": "Install spotify_player (brew)",
            },
          ],
      },
  }
---

# spogo / spotify_player

Use `spogo` **(preferred)** for Spotify playback/search. Fall back to `spotify_player` if `spogo` is not installed.

## When to Use

✅ **USE this skill when:**

- "Play [song/artist/playlist]"
- "Search Spotify for ..."
- "What's currently playing?"
- "Pause / skip / next / previous"
- "Show my playlists"
- "Show Spotify devices"
- "Set volume to 50"
- "Like this song"

## When NOT to Use

❌ **DON'T use this skill when:**

- Downloading or converting music files
- Non-Spotify music services (Apple Music, YouTube Music, etc.)
- Editing or processing audio files

## Requirements

- Spotify Premium account.
- Either `spogo` or `spotify_player` installed and authenticated.

## spogo Commands (preferred)

### Setup

```bash
spogo auth import --browser chrome
```

### Search

```bash
spogo search track "Bohemian Rhapsody"
spogo search artist "Queen"
spogo search album "A Night at the Opera"
spogo search playlist "Road Trip"
```

### Playback

```bash
spogo play
spogo pause
spogo next
spogo prev
spogo status
```

### Devices

```bash
spogo device list
spogo device set "<name|id>"
```

## spotify_player Commands (fallback)

### Setup

```bash
spotify_player authenticate
```

### Search

```bash
spotify_player search "Bohemian Rhapsody"
```

### Playback Status

```bash
spotify_player get key playback
```

### Devices

```bash
spotify_player get key devices
```

### User Playlists

```bash
spotify_player get key user-playlists
```

### Playback Controls

```bash
spotify_player playback play
spotify_player playback pause
spotify_player playback next
spotify_player playback previous
spotify_player playback volume 50
```

### Start Playing a Track

```bash
# Use a track ID from search results
spotify_player playback start track "TRACK_ID"
```

### Start a Playlist or Album

```bash
spotify_player playback start context "spotify:playlist:PLAYLIST_ID"
spotify_player playback start context "spotify:album:ALBUM_ID"
```

### Like / Unlike Current Track

```bash
spotify_player like
```

### Connect to a Device

```bash
spotify_player connect "DEVICE_ID"
```

### Playlist Management

```bash
spotify_player playlist list
spotify_player playlist new "My Playlist"
spotify_player playlist import "SOURCE_PLAYLIST_ID" "TARGET_PLAYLIST_ID"
```

## Notes

- `spotify_player` output is JSON — parse it to present results nicely to the user.
- `spotify_player` requires a running background instance for CLI commands. If you get "Connection refused", the user may need to restart it.
- Config folder: `~/.config/spotify-player/` (e.g., `app.toml`).
- Cache folder: `~/.cache/spotify-player/`.
- For Spotify Connect integration, set a user `client_id` in `app.toml`.
- Headless Linux / container setup has extra steps — see `references/headless-linux-setup.md`.
