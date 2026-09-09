---
summary: "Index of the OpenClaw text-to-speech documentation, one page per reader job"
title: "Text-to-speech"
sidebarTitle: "Text to speech (TTS)"
read_when:
  - Enabling text-to-speech for replies
  - Configuring a TTS provider, fallback chain, or persona
  - Using /tts commands or directives
---

OpenClaw converts outbound replies into native voice messages on Feishu, Matrix,
Telegram, and WhatsApp; audio attachments everywhere else; and PCM/Ulaw streams
for telephony and Talk.

TTS is the speech-output half of Talk's `stt-tts` mode (`talk.speak` calls this
same synthesis path). Provider-native `realtime` Talk sessions synthesize
speech inside the realtime provider instead; `transcription` sessions never
synthesize an assistant voice reply.

This page is an index. Text-to-speech is documented on seven pages, one per
reader job. Open the page that matches your task.

| Page                                                         | Read it when                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [Text-to-speech quickstart](/tools/tts/quickstart)           | You are turning TTS on, choosing a provider, and testing it from chat.                       |
| [Text-to-speech configuration](/tools/tts/configuration)     | You need the `tts` config block, a provider snippet, a local engine, or override precedence. |
| [Text-to-speech personas](/tools/tts/personas)               | You want one stable spoken identity, its provider bindings, and its fallback policy.         |
| [Commands and directives](/tools/tts/commands)               | You need `[[tts:...]]` directives, the `/tts` commands, or where local preferences live.     |
| [Output and Auto-TTS behavior](/tools/tts/output)            | You need the audio format per channel, transcoding rules, or when Auto-TTS summarizes.       |
| [Text-to-speech field reference](/tools/tts/field-reference) | You need the type, default, env var, or legacy alias for one TTS field.                      |
| [Agent tool and Gateway RPC](/tools/tts/api)                 | You are calling TTS from an agent tool call or a Gateway RPC method.                         |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/tools/tts#per-agent-voice-overrides` still
resolves. Each entry points at the page that now holds the content.

- <a id="quick-start" />[Quick start](/tools/tts/quickstart#quick-start)
- <a id="supported-providers" />[Supported providers](/tools/tts/quickstart#supported-providers)
- <a id="configuration" />[Configuration](/tools/tts/configuration#configuration)
- <a id="local-speech-swift-and-speech-core" />[Local Speech Swift and speech-core](/tools/tts/configuration#local-speech-swift-and-speech-core)
- <a id="per-agent-voice-overrides" />[Per-agent voice overrides](/tools/tts/configuration#per-agent-voice-overrides)
- <a id="personas" />[Personas](/tools/tts/personas#personas)
- <a id="minimal-persona" />[Minimal persona](/tools/tts/personas#minimal-persona)
- <a id="full-persona-(provider-specific-shaping)" />[Full persona (provider-specific shaping)](</tools/tts/personas#full-persona-(provider-specific-shaping)>)
- <a id="persona-resolution" />[Persona resolution](/tools/tts/personas#persona-resolution)
- <a id="custom-persona-shaping" />[Custom persona shaping](/tools/tts/personas#custom-persona-shaping)
- <a id="fallback-policy" />[Fallback policy](/tools/tts/personas#fallback-policy)
- <a id="model-driven-directives" />[Model-driven directives](/tools/tts/commands#model-driven-directives)
- <a id="slash-commands" />[Slash commands](/tools/tts/commands#slash-commands)
- <a id="per-user-preferences" />[Per-user preferences](/tools/tts/commands#per-user-preferences)
- <a id="output-formats" />[Output formats](/tools/tts/output#output-formats)
- <a id="auto-tts-behavior" />[Auto-TTS behavior](/tools/tts/output#auto-tts-behavior)
- <a id="field-reference" />[Field reference](/tools/tts/field-reference#field-reference)
- <a id="inworld-primary" />[Inworld primary](/tools/tts/field-reference#inworld-primary)
- <a id="agent-tool" />[Agent tool](/tools/tts/api#agent-tool)
- <a id="gateway-rpc" />[Gateway RPC](/tools/tts/api#gateway-rpc)
- <a id="full-persona-provider-specific-shaping" />[Full persona (provider-specific shaping)](/tools/tts/personas#full-persona-provider-specific-shaping)

## Component anchors

The previous single-page version also minted an anchor for every step, tab,
accordion, and field. Those anchors are preserved here so that any deep link
into the old page still resolves. Nine accordion anchors lost a `-1` suffix
when the tab that shared their slug moved to a different page; the stub below
keeps the old id and points at the new one.

**Quickstart**

- <a id="pick-a-provider" />[Pick a provider](/tools/tts/quickstart#pick-a-provider)
- <a id="set-the-api-key" />[Set the API key](/tools/tts/quickstart#set-the-api-key)
- <a id="enable-in-config" />[Enable in config](/tools/tts/quickstart#enable-in-config)
- <a id="try-it-in-chat" />[Try it in chat](/tools/tts/quickstart#try-it-in-chat)

**Configuration**

- <a id="azure-speech" />[Azure Speech](/tools/tts/configuration#azure-speech)
- <a id="elevenlabs" />[ElevenLabs](/tools/tts/configuration#elevenlabs)
- <a id="fish-audio" />[Fish Audio](/tools/tts/configuration#fish-audio)
- <a id="google-gemini" />[Google Gemini](/tools/tts/configuration#google-gemini)
- <a id="gradium" />[Gradium](/tools/tts/configuration#gradium)
- <a id="inworld" />[Inworld](/tools/tts/configuration#inworld)
- <a id="local-cli" />[Local CLI](/tools/tts/configuration#local-cli)
- <a id="microsoft-no-key" />[Microsoft (no key)](/tools/tts/configuration#microsoft-no-key)
- <a id="minimax" />[MiniMax](/tools/tts/configuration#minimax)
- <a id="openai-%2B-elevenlabs" />[OpenAI + ElevenLabs](/tools/tts/configuration#openai-%2B-elevenlabs)
- <a id="openrouter" />[OpenRouter](/tools/tts/configuration#openrouter)
- <a id="volcengine" />[Volcengine](/tools/tts/configuration#volcengine)
- <a id="xai" />[xAI](/tools/tts/configuration#xai)
- <a id="xiaomi-mimo" />[Xiaomi MiMo](/tools/tts/configuration#xiaomi-mimo)
- <a id="macos-http" />[macOS HTTP](/tools/tts/configuration#macos-http)
- <a id="macos-cli" />[macOS CLI](/tools/tts/configuration#macos-cli)
- <a id="linux-cli" />[Linux CLI](/tools/tts/configuration#linux-cli)
- <a id="windows-cli" />[Windows CLI](/tools/tts/configuration#windows-cli)

**Field reference**

- <a id="top-level-tts" />[Top-level tts.*](/tools/tts/field-reference#top-level-tts)
- <a id="param-auto" />[Top-level tts.* → `auto`](/tools/tts/field-reference#param-auto)
- <a id="param-enabled" />[Top-level tts.* → `enabled`](/tools/tts/field-reference#param-enabled)
- <a id="param-mode" />[Top-level tts.* → `mode`](/tools/tts/field-reference#param-mode)
- <a id="param-provider" />[Top-level tts.* → `provider`](/tools/tts/field-reference#param-provider)
- <a id="param-persona" />[Top-level tts.* → `persona`](/tools/tts/field-reference#param-persona)
- <a id="param-personas-id" />[Top-level tts.* → `personas.<id>`](/tools/tts/field-reference#param-personas-id)
- <a id="param-summary-model" />[Top-level tts.* → `summaryModel`](/tools/tts/field-reference#param-summary-model)
- <a id="param-model-overrides" />[Top-level tts.* → `modelOverrides`](/tools/tts/field-reference#param-model-overrides)
- <a id="param-providers-id" />[Top-level tts.* → `providers.<id>`](/tools/tts/field-reference#param-providers-id)
- <a id="param-max-text-length" />[Top-level tts.* → `maxTextLength`](/tools/tts/field-reference#param-max-text-length)
- <a id="param-timeout-ms" />[Top-level tts.* → `timeoutMs`](/tools/tts/field-reference#param-timeout-ms)
- <a id="azure-speech-1" />[Azure Speech](/tools/tts/field-reference#azure-speech)
- <a id="param-api-key" />[Azure Speech → `apiKey`](/tools/tts/field-reference#param-api-key)
- <a id="param-region" />[Azure Speech → `region`](/tools/tts/field-reference#param-region)
- <a id="param-endpoint" />[Azure Speech → `endpoint`](/tools/tts/field-reference#param-endpoint)
- <a id="param-speaker-voice" />[Azure Speech → `speakerVoice`](/tools/tts/field-reference#param-speaker-voice)
- <a id="param-lang" />[Azure Speech → `lang`](/tools/tts/field-reference#param-lang)
- <a id="param-output-format" />[Azure Speech → `outputFormat`](/tools/tts/field-reference#param-output-format)
- <a id="param-voice-note-output-format" />[Azure Speech → `voiceNoteOutputFormat`](/tools/tts/field-reference#param-voice-note-output-format)
- <a id="elevenlabs-1" />[ElevenLabs](/tools/tts/field-reference#elevenlabs)
- <a id="param-api-key-1" />[ElevenLabs → `apiKey`](/tools/tts/field-reference#param-api-key-1)
- <a id="param-model" />[ElevenLabs → `model`](/tools/tts/field-reference#param-model)
- <a id="param-speaker-voice-id" />[ElevenLabs → `speakerVoiceId`](/tools/tts/field-reference#param-speaker-voice-id)
- <a id="param-voice-settings" />[ElevenLabs → `voiceSettings`](/tools/tts/field-reference#param-voice-settings)
- <a id="param-apply-text-normalization" />[ElevenLabs → `applyTextNormalization`](/tools/tts/field-reference#param-apply-text-normalization)
- <a id="param-language-code" />[ElevenLabs → `languageCode`](/tools/tts/field-reference#param-language-code)
- <a id="param-seed" />[ElevenLabs → `seed`](/tools/tts/field-reference#param-seed)
- <a id="param-base-url" />[ElevenLabs → `baseUrl`](/tools/tts/field-reference#param-base-url)
- <a id="google-gemini-1" />[Google Gemini](/tools/tts/field-reference#google-gemini)
- <a id="param-api-key-2" />[Google Gemini → `apiKey`](/tools/tts/field-reference#param-api-key-2)
- <a id="param-model-1" />[Google Gemini → `model`](/tools/tts/field-reference#param-model-1)
- <a id="param-speaker-voice-1" />[Google Gemini → `speakerVoice`](/tools/tts/field-reference#param-speaker-voice-1)
- <a id="param-audio-profile" />[Google Gemini → `audioProfile`](/tools/tts/field-reference#param-audio-profile)
- <a id="param-speaker-name" />[Google Gemini → `speakerName`](/tools/tts/field-reference#param-speaker-name)
- <a id="param-prompt-template" />[Google Gemini → `promptTemplate`](/tools/tts/field-reference#param-prompt-template)
- <a id="param-persona-prompt" />[Google Gemini → `personaPrompt`](/tools/tts/field-reference#param-persona-prompt)
- <a id="param-base-url-1" />[Google Gemini → `baseUrl`](/tools/tts/field-reference#param-base-url-1)
- <a id="gradium-1" />[Gradium](/tools/tts/field-reference#gradium)
- <a id="param-api-key-3" />[Gradium → `apiKey`](/tools/tts/field-reference#param-api-key-3)
- <a id="param-base-url-2" />[Gradium → `baseUrl`](/tools/tts/field-reference#param-base-url-2)
- <a id="param-speaker-voice-id-1" />[Gradium → `speakerVoiceId`](/tools/tts/field-reference#param-speaker-voice-id-1)
- <a id="inworld-1" />[Inworld](/tools/tts/field-reference#inworld)
- <a id="param-api-key-4" />[Inworld → `apiKey`](/tools/tts/field-reference#param-api-key-4)
- <a id="param-base-url-3" />[Inworld → `baseUrl`](/tools/tts/field-reference#param-base-url-3)
- <a id="param-model-id" />[Inworld → `modelId`](/tools/tts/field-reference#param-model-id)
- <a id="param-speaker-voice-id-2" />[Inworld → `speakerVoiceId`](/tools/tts/field-reference#param-speaker-voice-id-2)
- <a id="param-temperature" />[Inworld → `temperature`](/tools/tts/field-reference#param-temperature)
- <a id="local-cli-tts-local-cli" />[Local CLI (tts-local-cli)](/tools/tts/field-reference#local-cli-tts-local-cli)
- <a id="param-command" />[Local CLI (tts-local-cli) → `command`](/tools/tts/field-reference#param-command)
- <a id="param-args" />[Local CLI (tts-local-cli) → `args`](/tools/tts/field-reference#param-args)
- <a id="param-output-format-1" />[Local CLI (tts-local-cli) → `outputFormat`](/tools/tts/field-reference#param-output-format-1)
- <a id="param-timeout-ms-1" />[Local CLI (tts-local-cli) → `timeoutMs`](/tools/tts/field-reference#param-timeout-ms-1)
- <a id="param-cwd" />[Local CLI (tts-local-cli) → `cwd`](/tools/tts/field-reference#param-cwd)
- <a id="param-env" />[Local CLI (tts-local-cli) → `env`](/tools/tts/field-reference#param-env)
- <a id="microsoft-no-api-key" />[Microsoft (no API key)](/tools/tts/field-reference#microsoft-no-api-key)
- <a id="param-enabled-1" />[Microsoft (no API key) → `enabled`](/tools/tts/field-reference#param-enabled-1)
- <a id="param-speaker-voice-2" />[Microsoft (no API key) → `speakerVoice`](/tools/tts/field-reference#param-speaker-voice-2)
- <a id="param-lang-1" />[Microsoft (no API key) → `lang`](/tools/tts/field-reference#param-lang-1)
- <a id="param-output-format-2" />[Microsoft (no API key) → `outputFormat`](/tools/tts/field-reference#param-output-format-2)
- <a id="param-rate-pitch-volume" />[Microsoft (no API key) → `rate / pitch / volume`](/tools/tts/field-reference#param-rate-pitch-volume)
- <a id="param-save-subtitles" />[Microsoft (no API key) → `saveSubtitles`](/tools/tts/field-reference#param-save-subtitles)
- <a id="param-proxy" />[Microsoft (no API key) → `proxy`](/tools/tts/field-reference#param-proxy)
- <a id="param-timeout-ms-2" />[Microsoft (no API key) → `timeoutMs`](/tools/tts/field-reference#param-timeout-ms-2)
- <a id="param-edge" />[Microsoft (no API key) → `edge.*`](/tools/tts/field-reference#param-edge)
- <a id="minimax-1" />[MiniMax](/tools/tts/field-reference#minimax)
- <a id="param-api-key-5" />[MiniMax → `apiKey`](/tools/tts/field-reference#param-api-key-5)
- <a id="param-base-url-4" />[MiniMax → `baseUrl`](/tools/tts/field-reference#param-base-url-4)
- <a id="param-model-2" />[MiniMax → `model`](/tools/tts/field-reference#param-model-2)
- <a id="param-speaker-voice-id-3" />[MiniMax → `speakerVoiceId`](/tools/tts/field-reference#param-speaker-voice-id-3)
- <a id="param-speed" />[MiniMax → `speed`](/tools/tts/field-reference#param-speed)
- <a id="param-vol" />[MiniMax → `vol`](/tools/tts/field-reference#param-vol)
- <a id="param-pitch" />[MiniMax → `pitch`](/tools/tts/field-reference#param-pitch)
- <a id="openai" />[OpenAI](/tools/tts/field-reference#openai)
- <a id="param-api-key-6" />[OpenAI → `apiKey`](/tools/tts/field-reference#param-api-key-6)
- <a id="param-model-3" />[OpenAI → `model`](/tools/tts/field-reference#param-model-3)
- <a id="param-speaker-voice-3" />[OpenAI → `speakerVoice`](/tools/tts/field-reference#param-speaker-voice-3)
- <a id="param-instructions" />[OpenAI → `instructions`](/tools/tts/field-reference#param-instructions)
- <a id="param-response-format" />[OpenAI → `responseFormat`](/tools/tts/field-reference#param-response-format)
- <a id="param-extra-body-extra-body" />[OpenAI → `extraBody / extra_body`](/tools/tts/field-reference#param-extra-body-extra-body)
- <a id="param-base-url-5" />[OpenAI → `baseUrl`](/tools/tts/field-reference#param-base-url-5)
- <a id="openrouter-1" />[OpenRouter](/tools/tts/field-reference#openrouter)
- <a id="param-api-key-7" />[OpenRouter → `apiKey`](/tools/tts/field-reference#param-api-key-7)
- <a id="param-base-url-6" />[OpenRouter → `baseUrl`](/tools/tts/field-reference#param-base-url-6)
- <a id="param-model-4" />[OpenRouter → `model`](/tools/tts/field-reference#param-model-4)
- <a id="param-speaker-voice-4" />[OpenRouter → `speakerVoice`](/tools/tts/field-reference#param-speaker-voice-4)
- <a id="param-response-format-1" />[OpenRouter → `responseFormat`](/tools/tts/field-reference#param-response-format-1)
- <a id="param-speed-1" />[OpenRouter → `speed`](/tools/tts/field-reference#param-speed-1)
- <a id="volcengine-byteplus-seed-speech" />[Volcengine (BytePlus Seed Speech)](/tools/tts/field-reference#volcengine-byteplus-seed-speech)
- <a id="param-api-key-8" />[Volcengine (BytePlus Seed Speech) → `apiKey`](/tools/tts/field-reference#param-api-key-8)
- <a id="param-resource-id" />[Volcengine (BytePlus Seed Speech) → `resourceId`](/tools/tts/field-reference#param-resource-id)
- <a id="param-app-key" />[Volcengine (BytePlus Seed Speech) → `appKey`](/tools/tts/field-reference#param-app-key)
- <a id="param-base-url-7" />[Volcengine (BytePlus Seed Speech) → `baseUrl`](/tools/tts/field-reference#param-base-url-7)
- <a id="param-speaker-voice-5" />[Volcengine (BytePlus Seed Speech) → `speakerVoice`](/tools/tts/field-reference#param-speaker-voice-5)
- <a id="param-speed-ratio" />[Volcengine (BytePlus Seed Speech) → `speedRatio`](/tools/tts/field-reference#param-speed-ratio)
- <a id="param-emotion" />[Volcengine (BytePlus Seed Speech) → `emotion`](/tools/tts/field-reference#param-emotion)
- <a id="param-app-id-token-cluster" />[Volcengine (BytePlus Seed Speech) → `appId / token / cluster`](/tools/tts/field-reference#param-app-id-token-cluster)
- <a id="xai-1" />[xAI](/tools/tts/field-reference#xai)
- <a id="param-api-key-9" />[xAI → `apiKey`](/tools/tts/field-reference#param-api-key-9)
- <a id="param-base-url-8" />[xAI → `baseUrl`](/tools/tts/field-reference#param-base-url-8)
- <a id="param-speaker-voice-id-4" />[xAI → `speakerVoiceId`](/tools/tts/field-reference#param-speaker-voice-id-4)
- <a id="param-language" />[xAI → `language`](/tools/tts/field-reference#param-language)
- <a id="param-response-format-2" />[xAI → `responseFormat`](/tools/tts/field-reference#param-response-format-2)
- <a id="param-speed-2" />[xAI → `speed`](/tools/tts/field-reference#param-speed-2)
- <a id="xiaomi-mimo-1" />[Xiaomi MiMo](/tools/tts/field-reference#xiaomi-mimo)
- <a id="param-api-key-10" />[Xiaomi MiMo → `apiKey`](/tools/tts/field-reference#param-api-key-10)
- <a id="param-base-url-9" />[Xiaomi MiMo → `baseUrl`](/tools/tts/field-reference#param-base-url-9)
- <a id="param-model-5" />[Xiaomi MiMo → `model`](/tools/tts/field-reference#param-model-5)
- <a id="param-speaker-voice-6" />[Xiaomi MiMo → `speakerVoice`](/tools/tts/field-reference#param-speaker-voice-6)
- <a id="param-format" />[Xiaomi MiMo → `format`](/tools/tts/field-reference#param-format)
- <a id="param-style" />[Xiaomi MiMo → `style`](/tools/tts/field-reference#param-style)

## Service links

- [Azure Speech provider](/providers/azure-speech)
- [Azure Speech REST text-to-speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Gradium](/providers/gradium)
- [Inworld TTS API](https://docs.inworld.ai/tts/tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)
- [MiniMax T2A v2 API](https://platform.minimaxi.com/document/T2A%20V2)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [OpenAI text-to-speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [speech-core](https://github.com/soniqo/speech-core)
- [Speech Swift](https://github.com/soniqo/speech-swift)
- [Volcengine TTS HTTP API](/providers/volcengine#text-to-speech)
- [xAI text to speech](https://docs.x.ai/developers/rest-api-reference/inference/voice#text-to-speech-rest)
- [Xiaomi MiMo speech synthesis](/providers/xiaomi#text-to-speech)

## Related

- [Media overview](/tools/media-overview)
- [Media playback](/nodes/media-playback)
- [Music generation](/tools/music-generation)
- [Video generation](/tools/video-generation)
- [Slash commands](/tools/slash-commands)
- [Voice call plugin](/plugins/voice-call)
