# Azure Speech

Generate spoken replies using Azure AI Speech. The plugin supports standard
audio files, native Ogg/Opus voice notes, and telephony output. Available voices
come from your Azure Speech resource.

## Get started

Provide `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` in the Gateway's environment.
Set `tts.provider` to `azure-speech` and choose a voice under
`tts.providers.azure-speech`. Set `tts.auto` to `always` if you want automatic
spoken replies.

Try a one-off reply with `/tts audio Hello from OpenClaw` in chat.

This requires an Azure **Speech** resource key, not an Azure OpenAI key.
See the [Azure Speech guide](https://docs.openclaw.ai/providers/azure-speech) for
voice selection, output formats, and endpoint configuration.
