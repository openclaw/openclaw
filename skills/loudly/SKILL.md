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

Use the bundled scripts to generate royalty-free AI music.

## Generate music by parameters

```bash
uv run {baseDir}/scripts/generate_music.py --genre "House" --duration 30 --energy 0.8 --bpm 125 --filename "house-track.mp3"
```

## Generate music by text prompt

```bash
uv run {baseDir}/scripts/generate_music.py --prompt "upbeat electronic track for a workout video" --duration 60 --filename "workout-music.mp3"
```

## List available genres

```bash
uv run {baseDir}/scripts/list_genres.py
```

## All options

| Flag             | Short | Description                                   |
| ---------------- | ----- | --------------------------------------------- |
| `--prompt`       | `-p`  | Text description for text-to-music generation |
| `--genre`        | `-g`  | Genre name (e.g. House, Ambient, Hip Hop)     |
| `--genre-blend`  |       | Second genre to blend with the primary        |
| `--duration`     | `-d`  | Duration in seconds (default: 30)             |
| `--energy`       | `-e`  | Energy level 0.0–1.0 (default: 0.5)           |
| `--bpm`          | `-b`  | Tempo in BPM (leave blank for genre default)  |
| `--key-root`     |       | Musical key root (e.g. C, D, F#)              |
| `--key-quality`  |       | Key quality: major or minor                   |
| `--instruments`  |       | Comma-separated instrument list               |
| `--structure-id` |       | Structure template ID                         |
| `--filename`     | `-f`  | Output filename (required)                    |
| `--api-key`      | `-k`  | Override LOUDLY_API_KEY env var               |

## API key

- `LOUDLY_API_KEY` env var
- Or set `skills."loudly".apiKey` / `skills."loudly".env.LOUDLY_API_KEY` in `~/.openclaw/openclaw.json`

## Available genres

Ambient, Downtempo, Drum 'n' Bass, EDM, Epic Score, Hip Hop, House, Lo Fi, Reggaeton, Rock, Synthwave, Techno, Trap Double Tempo, Trap Half Tempo, Zen

## Notes

- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.mp3`.
- The script prints a `MEDIA:` line for OpenClaw to auto-attach on supported chat providers.
- Do not play the audio back; report the saved path only.
- All generated music is royalty-free and commercially licensed.
- Either `--prompt` or `--genre` must be provided. If both are given, `--prompt` takes priority (text-to-music mode).
