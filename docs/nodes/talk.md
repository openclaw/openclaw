---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Talk mode: continuous speech conversations with ElevenLabs TTS"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementing Talk mode on macOS/iOS/Android（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing voice/TTS/interrupt behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Talk Mode"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Talk Mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Talk mode is a continuous voice conversation loop:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Listen for speech（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Send transcript to the model (main session, chat.send)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Wait for the response（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Speak it via ElevenLabs (streaming playback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Behavior (macOS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Always-on overlay** while Talk mode is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Listening → Thinking → Speaking** phase transitions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On a **short pause** (silence window), the current transcript is sent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replies are **written to WebChat** (same as typing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Interrupt on speech** (default on): if the user starts talking while the assistant is speaking, we stop playback and note the interruption timestamp for the next prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Voice directives in replies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The assistant may prefix its reply with a **single JSON line** to control voice:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "voice": "<voice-id>", "once": true }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rules:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- First non-empty line only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown keys are ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `once: true` applies to the current reply only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Without `once`, the voice becomes the new default for Talk mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The JSON line is stripped before TTS playback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Supported keys:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voice` / `voice_id` / `voiceId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model` / `model_id` / `modelId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `once`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config (`~/.openclaw/openclaw.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  talk: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    voiceId: "elevenlabs_voice_id",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    modelId: "eleven_v3",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    outputFormat: "mp3_44100_128",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    apiKey: "elevenlabs_api_key",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    interruptOnSpeech: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `interruptOnSpeech`: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voiceId`: falls back to `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (or first ElevenLabs voice when API key is available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `modelId`: defaults to `eleven_v3` when unset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `apiKey`: falls back to `ELEVENLABS_API_KEY` (or gateway shell profile if available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `outputFormat`: defaults to `pcm_44100` on macOS/iOS and `pcm_24000` on Android (set `mp3_*` to force MP3 streaming)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## macOS UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Menu bar toggle: **Talk**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config tab: **Talk Mode** group (voice id + interrupt toggle)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overlay:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Listening**: cloud pulses with mic level（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Thinking**: sinking animation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Speaking**: radiating rings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Click cloud: stop speaking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Click X: exit Talk mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires Speech + Microphone permissions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses `chat.send` against session key `main`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TTS uses ElevenLabs streaming API with `ELEVENLABS_API_KEY` and incremental playback on macOS/iOS/Android for lower latency.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stability` for `eleven_v3` is validated to `0.0`, `0.5`, or `1.0`; other models accept `0..1`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `latency_tier` is validated to `0..4` when set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android supports `pcm_16000`, `pcm_22050`, `pcm_24000`, and `pcm_44100` output formats for low-latency AudioTrack streaming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
