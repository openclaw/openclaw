# Deepgram

Transcribe recorded audio and live speech with Deepgram. The plugin supplies
audio understanding for incoming attachments and realtime transcription for
supported voice integrations.

## Get started

Provide `DEEPGRAM_API_KEY` in the Gateway's environment. For recorded audio,
select `deepgram` in `tools.media.models` with the `audio` capability and keep
`tools.media.audio.enabled` enabled. Send a voice note through a connected
channel to use the transcript in the conversation.

Realtime voice integrations have separate transcription settings. This plugin
transcribes speech; it does not provide speech synthesis.

See the [Deepgram guide](https://docs.openclaw.ai/providers/deepgram) and
[audio guide](https://docs.openclaw.ai/nodes/audio) for configuration and model
selection.
