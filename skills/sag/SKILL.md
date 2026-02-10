---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: sag（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: ElevenLabs text-to-speech with mac-style say UX.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://sag.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🗣️",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["sag"], "env": ["ELEVENLABS_API_KEY"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "primaryEnv": "ELEVENLABS_API_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/sag",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["sag"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install sag (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# sag（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `sag` for ElevenLabs TTS with local playback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
API key (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ELEVENLABS_API_KEY` (preferred)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SAG_API_KEY` also supported by the CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sag "Hello there"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sag speak -v "Roger" "Hello"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sag voices`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sag prompting` (model-specific tips)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `eleven_v3` (expressive)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stable: `eleven_multilingual_v2`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fast: `eleven_flash_v2_5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pronunciation + delivery rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- First fix: respell (e.g. "key-note"), add hyphens, adjust casing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Numbers/units/URLs: `--normalize auto` (or `off` if it harms names).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Language bias: `--lang en|de|fr|...` to guide normalization.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- v3: SSML `<break>` not supported; use `[pause]`, `[short pause]`, `[long pause]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- v2/v2.5: SSML `<break time="1.5s" />` supported; `<phoneme>` not exposed in `sag`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
v3 audio tags (put at the entrance of a line)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[whispers]`, `[shouts]`, `[sings]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[laughs]`, `[starts laughing]`, `[sighs]`, `[exhales]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[sarcastic]`, `[curious]`, `[excited]`, `[crying]`, `[mischievously]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example: `sag "[whispers] keep this quiet. [short pause] ok?"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Voice defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ELEVENLABS_VOICE_ID` or `SAG_VOICE_ID`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Confirm voice + speaker before long output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chat voice responses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When Peter asks for a "voice" reply (e.g., "crazy scientist voice", "explain in voice"), generate audio and send it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Generate audio file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sag -v Clawd -o /tmp/voice-reply.mp3 "Your message here"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Then include in reply:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# MEDIA:/tmp/voice-reply.mp3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Voice character tips:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Crazy scientist: Use `[excited]` tags, dramatic pauses `[short pause]`, vary intensity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Calm: Use `[whispers]` or slower pacing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dramatic: Use `[sings]` or `[shouts]` sparingly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default voice for Clawd: `lj2rcrvANS3gaWWnczSX` (or just `-v Clawd`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
