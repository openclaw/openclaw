# SenseAudio

Turn incoming audio and voice notes into text using SenseAudio. The plugin sends
recorded audio to SenseAudio's transcription service and returns the transcript
to OpenClaw's conversation pipeline.

## Get started

Provide `SENSEAUDIO_API_KEY` in the Gateway's environment. Select `senseaudio`
in `tools.media.models` with the `audio` capability, and enable
`tools.media.audio.enabled`.

Send a voice note through a connected channel to use its transcript in a reply.
Model and language options belong to the audio model configuration.

This is batch transcription; the plugin does not provide realtime transcription
or spoken output.

See the [SenseAudio guide](https://docs.openclaw.ai/providers/senseaudio) for a
complete configuration example.
