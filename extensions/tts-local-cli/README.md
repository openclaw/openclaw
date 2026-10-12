# Local CLI Text-to-Speech

Use an installed speech command to generate OpenClaw's spoken replies. The
plugin passes text to your executable and reads its audio output; it does not
install a speech engine or download voice models.

## Get started

Install and verify your preferred speech engine on the Gateway host. Set
`tts.provider` to `tts-local-cli` and configure `command`, `args`, and
`outputFormat` under `tts.providers.tts-local-cli`.

Arguments can use `{{Text}}`, `{{OutputPath}}`, `{{OutputDir}}`, `{{OutputBase}}`
and `{{VoiceId}}`. Without a text argument, OpenClaw sends the text on standard
input. Install FFmpeg when output needs conversion for voice notes or telephony.

## Voices

Your command owns its voice catalog, so declare it in config. List the voices
your engine accepts in `voices`, pick the active one with `voiceId`, and pass it
to your command with `{{VoiceId}}`:

```jsonc
// tts.providers.tts-local-cli
{
  "command": "/usr/local/bin/my-tts --voice {{VoiceId}}",
  "args": ["{{OutputPath}}"],
  "outputFormat": "wav",
  "voices": ["af_jessica", "af_bella", "am_michael"],
  "voiceId": "af_jessica",
}
```

The declared voices are what `/voice list` shows and what `/voice set`
chooses from (the command is `/talkvoice` on Discord). With `voices` unset, the configured `voiceId` is reported on its
own; with neither set, the voice list is empty and `{{VoiceId}}` expands to
nothing. `voiceId` does not have to appear in `voices` — the list advertises
choices, while `voiceId` selects what runs.

See [local speech configuration](https://docs.openclaw.ai/tools/tts/configuration)
for platform-specific examples and supported engines.
