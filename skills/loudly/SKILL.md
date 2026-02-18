---
name: loudly
description: Generate royalty-free AI music via Loudly Music API.
homepage: https://www.loudly.com/developers
metadata:
  {
    "openclaw":
      {
        "emoji": "🎵",
        "requires": { "bins": ["uv"], "env": ["LOUDLY_API_KEY"] },
        "primaryEnv": "LOUDLY_API_KEY",
        "install":
          [
            {
              "id": "uv-brew",
              "kind": "brew",
              "formula": "uv",
              "bins": ["uv"],
              "label": "Install uv (brew)",
            },
          ],
      },
  }
---

# Loudly (AI Music Generator)

Use the bundled scripts to generate royalty-free AI music. The `--genre` flag is always required.

## Generate music by genre

```bash
uv run {baseDir}/scripts/generate_music.py --genre "House" --duration 30 --energy high --bpm 125 --filename "house-track.mp3"
```

## Generate music with a text prompt

The prompt guides the AI alongside the genre (genre is still required):

```bash
uv run {baseDir}/scripts/generate_music.py --genre "Lo Fi" --prompt "chill study beats with vinyl crackle" --duration 60 --filename "study-music.mp3"
```

## List available genres

```bash
uv run {baseDir}/scripts/list_genres.py
```

## All options

| Flag             | Short | Description                                            |
| ---------------- | ----- | ------------------------------------------------------ |
| `--genre`        | `-g`  | Genre name — **required** (e.g. House, Lo Fi, EDM)     |
| `--prompt`       | `-p`  | Text description to guide generation (alongside genre) |
| `--genre-blend`  |       | Second genre to blend with the primary                 |
| `--duration`     | `-d`  | Duration in seconds (default: 30)                      |
| `--energy`       | `-e`  | Energy level: `low`, `high`, or `original`             |
| `--bpm`          | `-b`  | Tempo in BPM (leave blank for genre default)           |
| `--key-root`     |       | Musical key root (e.g. C, D, F#)                       |
| `--key-quality`  |       | Key quality: `major` or `minor`                        |
| `--instruments`  |       | Comma-separated instrument list                        |
| `--structure-id` |       | Structure template ID                                  |
| `--filename`     | `-f`  | Output filename — **required**                         |

## API key

Set `LOUDLY_API_KEY` via `skills."loudly".env.LOUDLY_API_KEY` in `~/.openclaw/openclaw.json`. The key is injected as an environment variable at runtime — never pass it as a CLI argument.

## Available genres

Ambient, Downtempo, Drum 'n' Bass, EDM, Epic Score, Hip Hop, House, Lo Fi, Reggaeton, Rock, Synthwave, Techno, Trap Double Tempo, Trap Half Tempo, Zen

Each genre has micro-genres (e.g. House → Afro House, Deep House, Tech House). Run `list_genres.py` to see the full tree.

## Notes

- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.mp3`.
- The script prints a `MEDIA:` line for OpenClaw to auto-attach on supported chat providers.
- Do not play the audio back; report the saved path only.
- All generated music is royalty-free and commercially licensed.
- The API is synchronous — results return immediately (no polling).
