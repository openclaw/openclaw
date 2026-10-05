---
summary: "Azure AI Speech dashboard dictation and text-to-speech for OpenClaw"
read_when:
  - You want Azure Speech synthesis for outbound replies
  - You need native Ogg Opus voice-note output from Azure Speech
  - You want to dictate dashboard chat drafts using Azure Speech
title: "Azure Speech"
---

Azure Speech is a bundled Azure AI Speech provider for dashboard dictation and
text-to-speech. For spoken replies, OpenClaw
calls the Azure Speech REST API directly with SSML, synthesizing MP3 for
standard replies, native Ogg/Opus for voice notes, and 8 kHz mulaw for
telephony channels such as Voice Call. The request sends the provider-owned
output format through the `X-Microsoft-OutputFormat` header.

| Detail                  | Value                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Provider ID             | `azure-speech` (alias: `azure`)                                                                                |
| Website                 | [Azure AI Speech](https://azure.microsoft.com/products/ai-services/ai-speech)                                  |
| Docs                    | [Speech REST text-to-speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech) |
| Auth                    | `AZURE_SPEECH_KEY` plus `AZURE_SPEECH_REGION`                                                                  |
| Default voice           | `en-US-JennyNeural`                                                                                            |
| Default file output     | `audio-24khz-48kbitrate-mono-mp3`                                                                              |
| Default voice-note file | `ogg-24khz-16bit-mono-opus`                                                                                    |

## Getting started

<Steps>
  <Step title="Create an Azure Speech resource">
    In the Azure portal, create a Speech resource. Copy **KEY 1** from
    Resource Management > Keys and Endpoint, and copy the resource location
    such as `eastus`.

    ```
    AZURE_SPEECH_KEY=<speech-resource-key>
    AZURE_SPEECH_REGION=eastus
    ```

  </Step>
  <Step title="Select Azure Speech in tts">
    ```json5
    {
      tts: {
        auto: "always",
        provider: "azure-speech",
        providers: {
          "azure-speech": {
            voice: "en-US-JennyNeural",
            lang: "en-US",
          },
        },
      },
    }
    ```
  </Step>
  <Step title="Send a message">
    Send a reply through any connected channel. OpenClaw synthesizes the audio
    with Azure Speech and delivers MP3 for standard audio, or Ogg/Opus when
    the channel expects a voice note.
  </Step>
</Steps>

## Dashboard dictation

The dashboard composer can stream microphone audio to Azure Speech and insert
the recognized words into your draft. This is speech-to-text, separate from
spoken replies and realtime Talk conversations.

Provide the same Speech resource key and region used for synthesis:

```text
AZURE_SPEECH_KEY=<speech-resource-key>
AZURE_SPEECH_REGION=eastus
```

Existing `tts.providers["azure-speech"].apiKey` and `.region` settings are also
reused, including resolved secret references. You do not need to enable
`tts.auto`. Azure becomes the automatic transcription provider only when no
earlier-priority provider is configured; an explicit transcription selection
always takes precedence.

Open the dashboard over HTTPS or `http://localhost`, allow microphone access,
and use the composer's dictation control. Partial text appears in the draft.
**Stop and keep text** waits briefly for final words; canceling dictation
discards its text. Dictation does not send the message for you.

Recognition inherits `tts.providers["azure-speech"].lang`, with `en-US` as the
default. To explicitly select Azure or override recognition settings, use the
existing transcription configuration:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          streaming: {
            provider: "azure-speech",
            providers: {
              "azure-speech": {
                language: "en-GB",
              },
            },
          },
        },
      },
    },
  },
}
```

This shared configuration path is used by dashboard transcription; it does not
start a phone call. Transcription-specific `apiKey`, `region`, and `language`
settings take precedence over inherited TTS settings and environment fallbacks.
The initial integration uses Azure's standard recognition model; do not set a
transcription `model` override. Custom recognition endpoints and model
deployments are not supported. TTS `endpoint` and `baseUrl` overrides are not
reused for recognition: an endpoint-only TTS setup also needs a Speech region
for dictation.

The Gateway converts its existing 8 kHz mu-law microphone stream to PCM for
Microsoft's Speech SDK. Your key stays on the Gateway; microphone audio is sent
to your Azure Speech resource and normal service usage charges apply.
OpenClaw does not save a raw audio recording for this dictation path.
Connection, authentication, quota, and finalization failures are reported rather
than silently switching to another provider.

This does not add transcription of uploaded recordings or incoming voice notes.

## Text-to-speech configuration options

The synthesis options below live under `tts.providers["azure-speech"]`.
Dictation also inherits `apiKey`, `region`, and `lang`.

| Option                  | Description                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `apiKey`                | Azure Speech resource key. Falls back to `AZURE_SPEECH_KEY`, `AZURE_SPEECH_API_KEY`, or `SPEECH_KEY`. |
| `region`                | Azure Speech resource region. Falls back to `AZURE_SPEECH_REGION` or `SPEECH_REGION`.                 |
| `endpoint`              | Optional Azure Speech endpoint override. Falls back to trusted `AZURE_SPEECH_ENDPOINT`.               |
| `baseUrl`               | Optional Azure Speech base URL override.                                                              |
| `voice`                 | Azure voice ShortName (default `en-US-JennyNeural`). Legacy alias: `voiceId`.                         |
| `lang`                  | SSML language code (default `en-US`).                                                                 |
| `outputFormat`          | Audio-file output format (default `audio-24khz-48kbitrate-mono-mp3`).                                 |
| `voiceNoteOutputFormat` | Voice-note output format (default `ogg-24khz-16bit-mono-opus`).                                       |
| `timeoutMs`             | Request timeout override in milliseconds. Falls back to the global `tts.timeoutMs`.                   |

The provider is considered configured once `apiKey` is set plus one of
`region`, `endpoint`, or `baseUrl`. Env vars are only checked as a fallback
for config keys left unset. Workspace `.env` files cannot set
`AZURE_SPEECH_ENDPOINT`; use the process environment, global runtime dotenv,
or explicit config for endpoint routing.

## Notes

<AccordionGroup>
  <Accordion title="Authentication">
    Azure Speech uses a Speech resource key, not an Azure OpenAI key. The key
    is sent as `Ocp-Apim-Subscription-Key`; OpenClaw derives
    `https://<region>.tts.speech.microsoft.com` from `region` unless you
    provide `endpoint` or `baseUrl`.
  </Accordion>
  <Accordion title="Voice names">
    Use the Azure Speech voice `ShortName` value, for example
    `en-US-JennyNeural`. The bundled provider can list voices through the
    same Speech resource and filters out voices marked deprecated, retired,
    or disabled.
  </Accordion>
  <Accordion title="Audio outputs">
    Azure accepts output formats such as `audio-24khz-48kbitrate-mono-mp3`,
    `ogg-24khz-16bit-mono-opus`, and `riff-24khz-16bit-mono-pcm`. OpenClaw
    requests Ogg/Opus for `voice-note` targets so channels can send native
    voice bubbles without an extra MP3 conversion, and forces
    `raw-8khz-8bit-mono-mulaw` for telephony targets.
  </Accordion>
  <Accordion title="Alias">
    `azure` is accepted as a provider alias for existing config, but new
    config should use `azure-speech` to avoid confusion with Azure OpenAI
    model providers.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Text-to-speech" href="/tools/tts" icon="waveform-lines">
    TTS overview, providers, and `tts` config.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference including `tts` settings.
  </Card>
  <Card title="Providers" href="/providers" icon="grid">
    All bundled OpenClaw providers.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and debugging steps.
  </Card>
</CardGroup>
