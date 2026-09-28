# Microsoft Speech

Give OpenClaw a voice through Microsoft's online Edge speech service. This
plugin provides neural text-to-speech without an API key, including voice
selection and adjustments to speaking rate and pitch.

## Get started

Set `tts.provider` to `microsoft` and configure a voice under
`tts.providers.microsoft`. Set `tts.auto` to `always` for automatic spoken
replies, or try `/tts audio Hello from OpenClaw` for a one-off reply.

The service requires network access and is best-effort, without a published SLA.
Use the separate Azure Speech plugin when you need an Azure Speech resource.

See [speech configuration](https://docs.openclaw.ai/tools/tts/configuration) for
the Microsoft preset and voice options.
