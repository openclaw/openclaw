---
summary: "Model-emitted TTS directives, the /tts slash commands, and per-user preferences"
title: "Text-to-speech commands and directives"
read_when:
  - You want the model to change voice or speed for one reply
  - You need the /tts command surface
  - You are looking for where local TTS preferences are stored
---

## Model-driven directives

By default, the assistant **can** emit `[[tts:...]]` directives to override
voice, model, or speed for a single reply, plus an optional
`[[tts:text]]...[[/tts:text]]` block for expressive cues that should appear in
audio only:

```text
Here you go.

[[tts:speakerVoiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

When `tts.auto` is `"tagged"`, **directives are required** to trigger
audio. Streaming block delivery strips directives from visible text before the
channel sees them, even when split across adjacent blocks.

`provider=...` is ignored unless `modelOverrides.allowProvider: true`. When a
reply declares `provider=...`, the other keys in that directive are parsed
only by that provider; unsupported keys are stripped and reported as TTS
directive warnings.

**Available directive keys:**

- `provider` (registered provider id; requires `allowProvider: true`)
- `speakerVoice` / `speakerVoiceId` (legacy aliases: `voice`, `voiceName`, `voice_name`, `google_voice`, `voiceId`)
- `model` / `google_model`
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `vol` / `volume` (MiniMax volume, `(0, 10]`)
- `pitch` (MiniMax integer pitch, −12 to 12; fractional values are truncated)
- `emotion` (Volcengine emotion tag)
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

**Disable model overrides entirely:**

```json5
{ tts: { modelOverrides: { enabled: false } } }
```

**Allow provider switching while keeping other knobs configurable:**

```json5
{ tts: { modelOverrides: { enabled: true, allowProvider: true, allowSeed: false } } }
```

## Slash commands

Single command `/tts`. On Discord, OpenClaw also registers `/voice` because
`/tts` is a built-in Discord command — text `/tts ...` still works.

```text
/tts off | on | status
/tts chat on | off | default
/tts latest
/tts provider <id>
/tts persona <id> | off
/tts limit <chars>
/tts summary off
/tts audio <text>
```

<Note>
Commands require an authorized sender (allowlist/owner rules apply) and either
`commands.text` or native command registration must be enabled.
</Note>

Behavior notes:

- `/tts on` writes the local TTS preference to `always`; `/tts off` writes it to `off`.
- `/tts chat on|off|default` writes a session-scoped auto-TTS override for the current chat.
- `/tts persona <id>` writes the local persona preference; `/tts persona off` clears it.
- `/tts latest` reads the latest assistant reply from the current session transcript and sends it as audio once. It stores only a hash of that reply on the session entry to suppress duplicate voice sends.
- `/tts audio` generates a one-off audio reply (does **not** toggle TTS on).
- `/tts limit <chars>` accepts **100–4096** (4096 is the Telegram caption/message max); values outside that range are rejected.
- `limit` and `summary` are stored in **local prefs**, not the main config.
- `/tts status` includes fallback diagnostics for the latest attempt — `Fallback: <primary> -> <used>`, `Attempts: ...`, and per-attempt detail (`provider:outcome(reasonCode) latency`).
- `/status` shows the active TTS mode plus configured provider, model, voice, and sanitized custom endpoint metadata when TTS is enabled.

## Per-user preferences

Slash commands write local overrides to the TTS preferences path. The default is
`~/.openclaw/settings/tts.json`; override it with `OPENCLAW_TTS_PREFS`. Doctor
moves the retired global `tts.prefsPath` value into shared machine state.
Advanced multi-agent setups may still set `agents.entries.<id>.tts.prefsPath`
when agents intentionally use separate preference stores.

| Stored field | Effect                                                                           |
| ------------ | -------------------------------------------------------------------------------- |
| `auto`       | Local auto-TTS override (`always`, `off`, …)                                     |
| `provider`   | Local primary provider override                                                  |
| `persona`    | Local persona override                                                           |
| `maxLength`  | Summary/truncation threshold (default `1500` chars, `/tts limit` range 100–4096) |
| `summarize`  | Summary toggle (default `true`)                                                  |

These override the effective config from `tts` plus the active
`agents.entries.*.tts` block for that host.
