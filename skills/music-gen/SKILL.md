---
name: music-gen
description: Generate a short music/audio clip from a text prompt via OpenRouter (Google Lyria) and send it as a file.
homepage: https://openrouter.ai/google/lyria-3-pro-preview
metadata:
  {
    "openclaw":
      {
        "emoji": "🎵",
        "requires": { "bins": ["python3"], "env": ["OPENROUTER_API_KEY"] },
        "primaryEnv": "OPENROUTER_API_KEY",
      },
  }
---

# Music Gen

Turn a text prompt into a short music/audio clip (mp3) using OpenRouter's Lyria
model, then send the file back on the current channel.

Use this when the user asks to **create / generate / make music, a song, a
jingle, background audio, or a soundtrack**. For _speech_ (reading text aloud),
use the built-in TTS instead — this is for generated music/audio, not narration.

## Run

```bash
python3 {baseDir}/scripts/generate.py "20 second calm lofi loop, no vocals"
# → prints the path to the generated .mp3

# optional explicit output path:
python3 {baseDir}/scripts/generate.py "upbeat 8-bit chiptune victory theme" /tmp/victory.mp3
```

Then **send the printed file** on the current channel (the same file-send you use
for any attachment — on Telegram it arrives as an audio message).

## Cost — read before generating a lot

Lyria is **billed ~$0.08 per song** and draws down OpenRouter credit. It is
**not** a free model, despite showing $0 token prices in the model list. So:

- Default to **short clips (~20–30 s)** unless the user asks otherwise.
- If the user asks for many tracks at once, say the rough cost first (e.g.
  "that's ~10 clips ≈ $0.80") and confirm.
- If credit runs out the script exits with an API `402` — relay that to the user
  ("the shared OpenRouter credit is exhausted; top up to keep generating").

## Notes

- The script streams the result (OpenRouter requires `stream: true` for audio)
  and writes an `.mp3`. On any API error it prints the message to stderr and
  exits non-zero — surface that to the user rather than retrying blindly.
- Model is overridable via `MUSIC_MODEL=<openrouter-model-id>` if a better music
  model appears; default is `google/lyria-3-pro-preview` (a preview model — it
  may change or disappear).
- Prompt tips: describe genre, mood, tempo, instruments, and duration; add
  "no vocals" / "instrumental" when you want music without singing.
