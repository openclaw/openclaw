---
name: lyria
description: Generate music via Google Lyria 3 API. Clip model outputs ~30s MP3. Pro model outputs up to 3 minutes (MP3 or WAV). Specify duration in the prompt for the pro model.
metadata:
  {
    "openclaw":
      {
        "emoji": "🎵",
        "requires": { "bins": ["python3"], "env": ["GEMINI_API_KEY"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---

# Lyria Music Generation

Generate music from text prompts using Google's Lyria 3 models.

## Models

| Flag             | Model ID               | Max Length      | Output     |
| ---------------- | ---------------------- | --------------- | ---------- |
| `clip` (default) | `lyria-3-clip-preview` | ~30 seconds     | MP3        |
| `pro`            | `lyria-3-pro-preview`  | up to 3 minutes | MP3 or WAV |

**Use `--model pro` whenever you need longer than ~30 seconds.** There is no numeric duration parameter — specify the desired length directly in your prompt text (e.g. `"2-minute ambient piece"`).

## Run

Note: Generation takes 30–90 seconds (longer for pro/longer tracks). Set exec timeout ≥ 300s.

```bash
# Short clip (default, ~30s)
python3 {baseDir}/scripts/gen.py "upbeat reggaeton instrumental, 96 BPM"

# Pro model — up to 3 minutes, length specified in the prompt
python3 {baseDir}/scripts/gen.py --model pro "2-minute lo-fi hip hop track, chill study beats, vinyl crackle"
python3 {baseDir}/scripts/gen.py --model pro "3-minute cinematic orchestral piece, intro builds to epic climax, strings and brass"

# Pro model with WAV output
python3 {baseDir}/scripts/gen.py --model pro --format wav "1-minute ambient piano, melancholic"

# Custom output directory
python3 {baseDir}/scripts/gen.py --out-dir /tmp/music "cinematic orchestral battle theme"

# JSON output (for downstream processing)
python3 {baseDir}/scripts/gen.py --json --model pro "2-minute dark trap beat, 140 BPM, 808 bass"
```

## Prompt Tips

- For **clip model**: include genre, BPM, mood, and instrumentation
- For **pro model**: also specify duration (e.g. `"2-minute"`, `"90-second"`) and song structure to guide length
  - `"2-minute pop song, verse-chorus-verse-chorus-outro structure"`
  - `"[0:00-0:30] Intro piano, [0:30-2:00] Full band enters, [2:00-2:30] Outro fades"`
- Examples:
  - `"upbeat reggaeton instrumental, 96 BPM, dem bow rhythm, synth lead"` (clip)
  - `"2-minute jazz trio, late night club feel, piano bass drums"` (pro)
  - `"3-minute cinematic orchestral battle theme, strings and brass, building to climax"` (pro)
  - `"dark trap beat, 140 BPM, 808 bass, ambient pads"` (clip)
  - `"lo-fi hip hop, relaxed study beats, vinyl crackle"` (clip)

## Environment

Reads `GEMINI_API_KEY` env var or `GEMINI_API_KEY_PATH` file (Docker secret pattern).
