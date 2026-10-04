# Spotify Integration

We use **spotify_player** as the primary Spotify integration. It is an open-source Rust TUI with full feature parity and no browser cookie dependency.

## Installation

1. Install via Homebrew: `brew install spotify_player`
2. Or via Cargo: `cargo install spotify_player`

## Usage & Details

- **Premium Required**: spotify_player requires a Spotify Premium account.
- **First Run**: Run `spotify_player` and authenticate via the TUI.
- **Controls**: play, pause, next, previous, seek, volume, shuffle, repeat.
- **Search**: Press `/` in the TUI, or use CLI options if available.
- **Programmatic Control Limitation**: Ensure `spotify_player` supports IPC or CLI arguments for programmatic control; if it is strictly TUI-only, true autonomous agent playback may be limited.

## Catalog Research (Read-Only)

For research without playback, use the `@crawlora-org/music-podcast-research` skill.
- Install: `openclaw skills install @crawlora-org/music-podcast-research`
- Covers Spotify tracks, podcasts, Apple Podcasts, Discogs, SoundCloud.
- Requires `CRAWLORA_API_KEY`.

## Fallback: spogo

If `spotify_player` cannot be controlled programmatically, `spogo` can be used as a fallback, but comes with **prominent warnings**:

- **Security Warning**: `spogo` uses browser cookie import (`spogo auth import --browser chrome`) which accesses sensitive browser cookies. This is a security tradeoff! Prefer OAuth if possible.
- **Known Bugs**: `spogo play [track]` may not change tracks (Issue #12) and `spogo play` resume may return 403.
- **DO NOT** run cookie import automatically. It must require explicit user action.

## SKILL.md Override

If the `@polyskill/openclaw.spotify-player` skill is installed, override its `SKILL.md` to:
1. Prefer `spotify_player`.
2. Disable automatic cookie import.
