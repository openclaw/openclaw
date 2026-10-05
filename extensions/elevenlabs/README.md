# ElevenLabs

Give OpenClaw a voice and transcribe audio with ElevenLabs. This bundled plugin
supports text-to-speech, transcription of recorded audio, and realtime
transcription for supported voice integrations.

## Get started

Provide an ElevenLabs API key using `ELEVENLABS_API_KEY` in the Gateway's
environment. Choose ElevenLabs as your speech provider and configure a voice for
spoken replies, or select it for audio transcription.

Speech output, recorded audio, and realtime transcription have separate settings;
configure the capability you want to use. Set the speech model to
`eleven_v4_turbo` for low-latency agent speech. That model uses the Text to
Dialogue WebSocket. `eleven_v4` is the slower narration model on the same
socket. Flash and Multilingual stay on text-to-speech.

The [ElevenLabs guide](https://docs.openclaw.ai/providers/elevenlabs) includes setup
examples for each capability, including Voice Call and Google Meet integrations.
