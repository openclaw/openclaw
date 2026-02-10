# Add TTS Post-Processing Hook for Voice Modulation

## Summary

Adds a configurable post-processing hook to `messages.tts` that allows audio manipulation (pitch, speed, effects) after TTS generation but before delivery. Includes an example FFmpeg pitch-modulation plugin demonstrating the pattern.

## Motivation

Users want to customize TTS voice characteristics beyond what providers offer:

- Deeper/higher pitch for personality customization
- Speed adjustments
- Custom audio effects (reverb, EQ, etc.)

Current workaround requires manual post-processing or forking TTS code. This PR makes it a first-class config feature.

## Changes

### Core TTS (`src/tts/tts.ts`)

- Added `applyPostProcessing()` helper function
- Calls post-processing hook after TTS generation (both Edge and API providers)
- Graceful fallback to original audio on failure
- Timeout protection (default 5s, configurable 100ms-30s)

### Config Types (`src/config/types.tts.ts`)

- Added `postProcess` field to `TtsConfig`:
  - `enabled?: boolean` — Enable/disable post-processing
  - `command?: string` — Path to processing script (supports `~` expansion)
  - `timeoutMs?: number` — Timeout in milliseconds
  - `env?: Record<string, string>` — Environment variables for the command

### Zod Schema (`src/config/zod-schema.core.ts`)

- Added validation for `messages.tts.postProcess` config block

### Example Plugin (`extensions/tts-ffmpeg-pitch/`)

- **Plugin manifest**: `openclaw.plugin.json` with config schema
- **CLI command**: `openclaw tts-pitch` for testing transformations
- **Processing script**: `bin/process-audio.sh` (FFmpeg pitch/speed modulation)
- **Documentation**: Full README with examples and troubleshooting

### Tests (`src/tts/tts-post-process.test.ts`)

- Post-processing disabled (skip when `enabled: false`)
- Post-processing with no command (skip when command missing)
- Passthrough processing (cat/cp commands)
- Fallback on failure (non-zero exit, missing output)
- Environment variable passing
- Timeout handling

### Documentation

- `docs/tts-post-processing.md` — Comprehensive guide with examples
- `extensions/tts-ffmpeg-pitch/README.md` — Plugin usage and config

## Example Usage

### Deeper Voice (TARS-style)

```json
{
  "messages": {
    "tts": {
      "provider": "openai",
      "postProcess": {
        "enabled": true,
        "command": "~/.openclaw/extensions/tts-ffmpeg-pitch/bin/process-audio.sh",
        "timeoutMs": 8000,
        "env": {
          "FFMPEG_PITCH": "0.82"
        }
      }
    }
  }
}
```

### Higher, Faster Voice

```json
{
  "messages": {
    "tts": {
      "provider": "openai",
      "postProcess": {
        "enabled": true,
        "command": "~/.openclaw/extensions/tts-ffmpeg-pitch/bin/process-audio.sh",
        "env": {
          "FFMPEG_PITCH": "1.2",
          "FFMPEG_SPEED": "1.15"
        }
      }
    }
  }
}
```

## Command Interface

Processing commands receive:

- **`OPENCLAW_TTS_INPUT`**: Path to original TTS audio file
- **`OPENCLAW_TTS_OUTPUT`**: Path where processed audio should be written
- **Custom env vars**: Any variables from `postProcess.env`

Commands must:

- Write processed audio to `$OPENCLAW_TTS_OUTPUT`
- Exit with code `0` on success
- Exit with non-zero on failure (triggers fallback to original)

## Error Handling

All failures are **fail-safe**:

- Command not found → original audio
- Non-zero exit → original audio
- Timeout → kill process, original audio
- Missing output file → original audio

Failures logged via `logVerbose()` for debugging.

## Breaking Changes

None. Feature is opt-in and disabled by default.

## Testing

Run the full gate:

```bash
pnpm build && pnpm check && pnpm test
```

Run post-processing tests:

```bash
pnpm test src/tts/tts-post-process.test.ts
```

## AI Attribution

**AI-assisted (Claude Sonnet 4.5)** — Plan and implementation reviewed and tested by human.

Design session: [planning transcript available on request]

## Checklist

- [x] Config types updated (`src/config/types.tts.ts`)
- [x] Zod schema validation added (`src/config/zod-schema.core.ts`)
- [x] Core TTS hook implemented (`src/tts/tts.ts`)
- [x] Example plugin created (`extensions/tts-ffmpeg-pitch/`)
- [x] Tests written (`src/tts/tts-post-process.test.ts`)
- [x] Documentation added (`docs/tts-post-processing.md`, plugin README)
- [ ] Full gate passed (`pnpm build && pnpm check && pnpm test`)
- [ ] Tested manually with FFmpeg plugin

## Follow-ups (optional)

- [ ] Add per-provider post-processing config
- [ ] Add per-message post-processing directives
- [ ] Add plugin API for registered transforms (beyond command-based)
- [ ] Support telephony TTS post-processing (buffer-based)

## Related Issues

- Addresses user requests for voice customization
- Complements existing TTS directive system (`[[tts:...]]`)
