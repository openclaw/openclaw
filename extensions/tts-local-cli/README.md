# Local CLI Text-to-Speech

Use an installed speech command to generate OpenClaw's spoken replies. The
plugin passes text to your executable and reads its audio output; it does not
install a speech engine or download voice models.

## Get started

Install and verify your preferred speech engine on the Gateway host. Set
`tts.provider` to `tts-local-cli` and configure `command`, `args`, and
`outputFormat` under `tts.providers.tts-local-cli`.

Arguments can use `{{Text}}` and `{{OutputPath}}`. Without a text argument,
OpenClaw sends the text on standard input. Install FFmpeg when output needs
conversion for voice notes or telephony.

See [local speech configuration](https://docs.openclaw.ai/tools/tts/configuration)
for platform-specific examples and supported engines.
