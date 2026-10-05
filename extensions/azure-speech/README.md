# Azure Speech

Dictate chat drafts and generate spoken replies using Azure AI Speech. The
plugin supports streaming dashboard dictation, standard audio files, native
Ogg/Opus voice notes, and telephony output. Available voices come from your
Azure Speech resource.

## Get started

Provide `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` in the Gateway's environment.
Set `tts.provider` to `azure-speech` and choose a voice under
`tts.providers.azure-speech`. Set `tts.auto` to `always` if you want automatic
spoken replies.

Try a one-off reply with `/tts audio Hello from OpenClaw` in chat.

This requires an Azure **Speech** resource key, not an Azure OpenAI key.
See the [Azure Speech guide](https://docs.openclaw.ai/providers/azure-speech) for
voice selection, output formats, and endpoint configuration.

## Dashboard dictation

With `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` configured, use the dashboard
composer microphone to dictate into a draft. Existing keys and regions under
`tts.providers.azure-speech` are also reused; automatic spoken replies do not
need to be enabled.

Azure is the last automatic transcription choice and does not replace an
explicitly selected provider. It uses the standard Azure recognition model and
inherits `tts.providers.azure-speech.lang`, defaulting to `en-US`.
**Stop and keep text** finishes the transcript; **Cancel** discards the dictated
text without sending a message.

Audio is streamed through the Gateway to your Azure Speech resource and is
subject to Azure service usage charges. The SDK is loaded only when dictation
starts. A TTS endpoint-only configuration also needs a resource region for
dictation. This capability does not add uploaded-audio transcription or a
realtime spoken-assistant conversation.
