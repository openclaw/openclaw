---
summary: "Every tts.* and tts.providers.<id>.* configuration field"
title: "Text-to-speech field reference"
read_when:
  - You need the type, default, or env var for one TTS field
  - You are checking a legacy field alias
  - You are validating a provider block
---

## Field reference

<AccordionGroup>
  <Accordion title="Top-level tts.*">
    <ParamField path="auto" type='"off" | "always" | "inbound" | "tagged"'>
      Auto-TTS mode. `inbound` only sends audio after an inbound voice message; `tagged` only sends audio when the reply includes `[[tts:...]]` directives or a `[[tts:text]]` block.
    </ParamField>
    <ParamField path="enabled" type="boolean" deprecated>
      Legacy toggle. `openclaw doctor --fix` migrates this to `auto`.
    </ParamField>
    <ParamField path="mode" type='"final" | "all"' default="final">
      `"all"` includes tool/block replies in addition to final replies.
    </ParamField>
    <ParamField path="provider" type="string">
      Speech provider id. When unset, OpenClaw uses the first configured provider in registry auto-select order. Legacy `provider: "edge"` is rewritten to `"microsoft"` by `openclaw doctor --fix`.
    </ParamField>
    <ParamField path="persona" type="string">
      Active persona id from `personas`. Normalized to lowercase.
    </ParamField>
    <ParamField path="personas.<id>" type="object">
      Stable spoken identity. Fields: `label`, `description`, `provider`, `fallbackPolicy`, `providers.<provider>`. See [Personas](/tools/tts/personas#personas).
    </ParamField>
    <ParamField path="summaryModel" type="string">
      Cheap model for auto-summary; defaults to `agents.defaults.model.primary`. Accepts `provider/model` or a configured model alias.
    </ParamField>
    <ParamField path="modelOverrides" type="object">
      Allow the model to emit TTS directives. `enabled` defaults to `true`; `allowProvider` defaults to `false`.
    </ParamField>
    <ParamField path="providers.<id>" type="object">
      Provider-owned settings keyed by speech provider id. Legacy direct blocks (`tts.openai`, `.elevenlabs`, `.microsoft`, `.edge`) are rewritten by `openclaw doctor --fix`; commit only `tts.providers.<id>`.
    </ParamField>
    <ParamField path="maxTextLength" type="number" default="4096">
      Hard cap for TTS input characters. `/tts audio`, `tts.convert`, and `tts.speak` fail if exceeded.
    </ParamField>
    <ParamField path="timeoutMs" type="number" default="30000">
      Request timeout in milliseconds. A per-call `timeoutMs` (agent tool, gateway) wins when set; otherwise an explicitly configured `tts.timeoutMs` wins over any plugin-authored provider default.
    </ParamField>
  </Accordion>

Provider `apiKey` fields, including `personas.<id>.providers.<provider>.apiKey`,
can be raw strings or SecretRefs in global, per-agent, and Discord voice TTS config.
During cold Gateway startup, an unavailable TTS SecretRef marks the built-in TTS capability
configured-unavailable instead of stopping the Gateway. `tts.speak` then returns
`UNAVAILABLE` with reason `SECRET_SURFACE_UNAVAILABLE`, and no provider request is
sent. Status and doctor list the degraded TTS owner and its config paths. The
explicit refs remain in the runtime snapshot, so environment or profile
credentials cannot silently select a different account. Reloads and config-write
preflight apply the owner-aware degradation policy: an unchanged eligible TTS
owner may keep its last-known-good credentials as stale, while a new or changed
failure becomes cold without blocking healthy owners. Structurally invalid refs
and resolved values still fail startup or reject the update.

  <Accordion title="Azure Speech">
    <ParamField path="apiKey" type="string">Env: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_API_KEY`, or `SPEECH_KEY`.</ParamField>
    <ParamField path="region" type="string">Azure Speech region (e.g. `eastus`). Env: `AZURE_SPEECH_REGION` or `SPEECH_REGION`.</ParamField>
    <ParamField path="endpoint" type="string">Optional Azure Speech endpoint override (alias `baseUrl`).</ParamField>
    <ParamField path="speakerVoice" type="string">Azure voice ShortName. Default `en-US-JennyNeural`. Legacy alias: `voice`.</ParamField>
    <ParamField path="lang" type="string">SSML language code. Default `en-US`.</ParamField>
    <ParamField path="outputFormat" type="string">Azure `X-Microsoft-OutputFormat` for standard audio. Default `audio-24khz-48kbitrate-mono-mp3`.</ParamField>
    <ParamField path="voiceNoteOutputFormat" type="string">Azure `X-Microsoft-OutputFormat` for voice-note output. Default `ogg-24khz-16bit-mono-opus`.</ParamField>
  </Accordion>

  <Accordion title="ElevenLabs">
    <ParamField path="apiKey" type="string">Falls back to `ELEVENLABS_API_KEY` or `XI_API_KEY`.</ParamField>
    <ParamField path="model" type="string">Model id. Default `eleven_multilingual_v2`. Legacy ids `eleven_turbo_v2_5`/`eleven_turbo_v2` are normalized to the matching `flash` model.</ParamField>
    <ParamField path="speakerVoiceId" type="string">ElevenLabs voice id. Default `pMsXgVXv3BLzUgSXRplE`. Legacy alias: `voiceId`.</ParamField>
    <ParamField path="voiceSettings" type="object">
      `stability`, `similarityBoost`, `style` (each `0..1`, defaults `0.5`/`0.75`/`0`), `useSpeakerBoost` (`true|false`, default `true`), `speed` (`0.5..2.0`, default `1.0`).
    </ParamField>
    <ParamField path="applyTextNormalization" type='"auto" | "on" | "off"'>Text normalization mode.</ParamField>
    <ParamField path="languageCode" type="string">2-letter ISO 639-1 (e.g. `en`, `de`).</ParamField>
    <ParamField path="seed" type="number">Integer `0..4294967295` for best-effort determinism.</ParamField>
    <ParamField path="baseUrl" type="string">Override ElevenLabs API base URL.</ParamField>
  </Accordion>

  <Accordion title="Google Gemini">
    <ParamField path="apiKey" type="string">Falls back to `GEMINI_API_KEY` / `GOOGLE_API_KEY`. If omitted, TTS can reuse `models.providers.google.apiKey` before env fallback.</ParamField>
    <ParamField path="model" type="string">Gemini TTS model. Default `gemini-3.1-flash-tts-preview`.</ParamField>
    <ParamField path="speakerVoice" type="string">Gemini prebuilt voice name. Default `Kore`. Legacy aliases: `voiceName`, `voice`.</ParamField>
    <ParamField path="audioProfile" type="string">Natural-language style prompt prepended before spoken text.</ParamField>
    <ParamField path="speakerName" type="string">Optional speaker label prepended before spoken text when your prompt uses a named speaker.</ParamField>
    <ParamField path="promptTemplate" type='"audio-profile-v1"'>Set to `audio-profile-v1` to wrap active persona prompt fields in a deterministic Gemini TTS prompt structure.</ParamField>
    <ParamField path="personaPrompt" type="string">Google-specific extra persona prompt text appended to the template's Director's Notes.</ParamField>
    <ParamField path="baseUrl" type="string">Only `https://generativelanguage.googleapis.com` is accepted.</ParamField>
  </Accordion>

  <Accordion title="Gradium">
    <ParamField path="apiKey" type="string">Env: `GRADIUM_API_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">HTTPS Gradium API URL on `api.gradium.ai`. Default `https://api.gradium.ai`.</ParamField>
    <ParamField path="speakerVoiceId" type="string">Default Emma (`YTpq7expH9539ERJ`). Legacy alias: `voiceId`.</ParamField>
  </Accordion>

  <Accordion title="Inworld">
    ### Inworld primary

    <ParamField path="apiKey" type="string">Env: `INWORLD_API_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">Default `https://api.inworld.ai`.</ParamField>
    <ParamField path="modelId" type="string">Default `inworld-tts-1.5-max`. Also: `inworld-tts-1.5-mini`, `inworld-tts-1-max`, `inworld-tts-1`.</ParamField>
    <ParamField path="speakerVoiceId" type="string">Default `Sarah`. Legacy alias: `voiceId`.</ParamField>
    <ParamField path="temperature" type="number">Sampling temperature `0..2` (exclusive of 0).</ParamField>

  </Accordion>

  <Accordion title="Local CLI (tts-local-cli)">
    <ParamField path="command" type="string">Local executable or command string for CLI TTS.</ParamField>
    <ParamField path="args" type="string[]">Command arguments. Supports `{{Text}}`, `{{OutputPath}}`, `{{OutputDir}}`, `{{OutputBase}}` placeholders.</ParamField>
    <ParamField path="outputFormat" type='"mp3" | "opus" | "wav"'>Expected CLI output format. Default `mp3` for audio attachments.</ParamField>
    <ParamField path="timeoutMs" type="number">Command timeout in milliseconds. Overrides the resolved TTS request timeout when set. When omitted, follows the request timeout; the plugin default is `120000`.</ParamField>
    <ParamField path="cwd" type="string">Optional command working directory.</ParamField>
    <ParamField path="env" type="Record<string, string>">Optional environment overrides for the command.</ParamField>

    Command stdout and generated or converted audio are limited to 50 MiB. Diagnostic stderr is limited to 1 MiB. OpenClaw terminates the command and fails synthesis when either limit is exceeded.

  </Accordion>

  <Accordion title="Microsoft (no API key)">
    <ParamField path="enabled" type="boolean" default="true">Allow Microsoft speech usage.</ParamField>
    <ParamField path="speakerVoice" type="string">Microsoft neural voice name (e.g. `en-US-MichelleNeural`). Legacy alias: `voice`. If the default English voice is in effect and reply text is CJK-dominant, OpenClaw auto-switches to `zh-CN-XiaoxiaoNeural`.</ParamField>
    <ParamField path="lang" type="string">Language code (e.g. `en-US`).</ParamField>
    <ParamField path="outputFormat" type="string">Microsoft output format. Default `audio-24khz-48kbitrate-mono-mp3`. Not all formats are supported by the bundled Edge-backed transport.</ParamField>
    <ParamField path="rate / pitch / volume" type="string">Percent strings (e.g. `+10%`, `-5%`).</ParamField>
    <ParamField path="saveSubtitles" type="boolean">Write JSON subtitles alongside the audio file.</ParamField>
    <ParamField path="proxy" type="string">Proxy URL for Microsoft speech requests.</ParamField>
    <ParamField path="timeoutMs" type="number">Request timeout override (ms).</ParamField>
    <ParamField path="edge.*" type="object" deprecated>Legacy alias. Run `openclaw doctor --fix` to rewrite persisted config to `providers.microsoft`.</ParamField>
  </Accordion>

  <Accordion title="MiniMax">
    <ParamField path="apiKey" type="string">Falls back to `MINIMAX_API_KEY`. Token Plan auth via `MINIMAX_OAUTH_TOKEN`, `MINIMAX_CODE_PLAN_KEY`, or `MINIMAX_CODING_API_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">Default `https://api.minimax.io`. Env: `MINIMAX_API_HOST`.</ParamField>
    <ParamField path="model" type="string">Default `speech-2.8-hd`. Env: `MINIMAX_TTS_MODEL`.</ParamField>
    <ParamField path="speakerVoiceId" type="string">Default `English_expressive_narrator`. Env: `MINIMAX_TTS_VOICE_ID`. Legacy alias: `voiceId`.</ParamField>
    <ParamField path="speed" type="number">`0.5..2.0`. Default `1.0`.</ParamField>
    <ParamField path="vol" type="number">`(0, 10]`. Default `1.0`.</ParamField>
    <ParamField path="pitch" type="number">Integer `-12..12`. Default `0`. Fractional values are truncated before the request.</ParamField>
  </Accordion>

  <Accordion title="OpenAI">
    <ParamField path="apiKey" type="string">Falls back to `OPENAI_API_KEY`.</ParamField>
    <ParamField path="model" type="string">OpenAI TTS model id. Default `gpt-4o-mini-tts`.</ParamField>
    <ParamField path="speakerVoice" type="string">Voice name (e.g. `alloy`, `cedar`). Default `coral`. Legacy alias: `voice`.</ParamField>
    <ParamField path="instructions" type="string">Explicit OpenAI `instructions` field. When set, persona prompt fields are **not** auto-mapped.</ParamField>
    <ParamField path="responseFormat" type='"mp3" | "opus" | "wav"'>Explicit response format. When omitted, OpenClaw selects Opus for voice-note targets and MP3 otherwise. Use `wav` for compatible local endpoints that do not encode compressed audio.</ParamField>
    <ParamField path="extraBody / extra_body" type="Record<string, unknown>">Extra JSON fields merged into `/audio/speech` request bodies after generated OpenAI TTS fields. Use this for OpenAI-compatible endpoints such as Kokoro that require provider-specific keys like `lang`; unsafe prototype keys are ignored.</ParamField>
    <ParamField path="baseUrl" type="string">
      Override the OpenAI TTS endpoint. Resolution order: config → `OPENAI_TTS_BASE_URL` → `https://api.openai.com/v1`. Non-default values are treated as OpenAI-compatible TTS endpoints, so custom model and voice names are accepted, and `speed` loses its `0.25..4.0` range check.
    </ParamField>
  </Accordion>

  <Accordion title="OpenRouter">
    <ParamField path="apiKey" type="string">Env: `OPENROUTER_API_KEY`. Can reuse `models.providers.openrouter.apiKey`.</ParamField>
    <ParamField path="baseUrl" type="string">Default `https://openrouter.ai/api/v1`. Legacy `https://openrouter.ai/v1` is normalized.</ParamField>
    <ParamField path="model" type="string">Default `hexgrad/kokoro-82m`. Alias: `modelId`.</ParamField>
    <ParamField path="speakerVoice" type="string">Default `af_alloy`. Legacy aliases: `voice`, `voiceId`.</ParamField>
    <ParamField path="responseFormat" type='"mp3" | "pcm"'>Default `mp3`.</ParamField>
    <ParamField path="speed" type="number">Provider-native speed override.</ParamField>
  </Accordion>

  <Accordion title="Volcengine (BytePlus Seed Speech)">
    <ParamField path="apiKey" type="string">Env: `VOLCENGINE_TTS_API_KEY` or `BYTEPLUS_SEED_SPEECH_API_KEY`.</ParamField>
    <ParamField path="resourceId" type="string">Default `seed-tts-1.0`. Env: `VOLCENGINE_TTS_RESOURCE_ID`. Use `seed-tts-2.0` when your project has TTS 2.0 entitlement.</ParamField>
    <ParamField path="appKey" type="string">App key header. Default `aGjiRDfUWi`. Env: `VOLCENGINE_TTS_APP_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">Override the Seed Speech TTS HTTP endpoint. Env: `VOLCENGINE_TTS_BASE_URL`.</ParamField>
    <ParamField path="speakerVoice" type="string">Voice type. Default `en_female_anna_mars_bigtts`. Env: `VOLCENGINE_TTS_VOICE`. Legacy alias: `voice`.</ParamField>
    <ParamField path="speedRatio" type="number">Provider-native speed ratio, `0.2..3`.</ParamField>
    <ParamField path="emotion" type="string">Provider-native emotion tag.</ParamField>
    <ParamField path="appId / token / cluster" type="string" deprecated>Legacy Volcengine Speech Console fields. Env: `VOLCENGINE_TTS_APPID`, `VOLCENGINE_TTS_TOKEN`, `VOLCENGINE_TTS_CLUSTER` (default `volcano_tts`).</ParamField>
  </Accordion>

  <Accordion title="xAI">
    <ParamField path="apiKey" type="string">Env: `XAI_API_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">Default `https://api.x.ai/v1`. Env: `XAI_BASE_URL`.</ParamField>
    <ParamField path="speakerVoiceId" type="string">Default `eve`. With auth, `openclaw infer tts voices --provider xai` fetches the current built-in catalog; without auth it lists offline fallbacks `ara`, `eve`, `leo`, `rex`, and `sal`. Account custom voice IDs are forwarded even when absent from the built-in list. Legacy alias: `voiceId`.</ParamField>
    <ParamField path="language" type="string">BCP-47 language code or `auto`. Default `en`.</ParamField>
    <ParamField path="responseFormat" type='"mp3" | "wav" | "pcm" | "mulaw" | "alaw"'>Default `mp3`.</ParamField>
    <ParamField path="speed" type="number">Provider-native speed override, `0.7..1.5`.</ParamField>
  </Accordion>

  <Accordion title="Xiaomi MiMo">
    <ParamField path="apiKey" type="string">Env: `XIAOMI_API_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">Default `https://api.xiaomimimo.com/v1`. Env: `XIAOMI_BASE_URL`.</ParamField>
    <ParamField path="model" type="string">Default `mimo-v2.5-tts`. Env: `XIAOMI_TTS_MODEL`. Also supports `mimo-v2.5-tts-voicedesign`.</ParamField>
    <ParamField path="speakerVoice" type="string">Default `mimo_default` for preset-voice models. Env: `XIAOMI_TTS_VOICE`. Legacy alias: `voice`. Not sent for `mimo-v2.5-tts-voicedesign`.</ParamField>
    <ParamField path="format" type='"mp3" | "wav"'>Default `mp3`. Env: `XIAOMI_TTS_FORMAT`.</ParamField>
    <ParamField path="style" type="string">Optional natural-language style instruction sent as the user message; not spoken. For `mimo-v2.5-tts-voicedesign`, this is the voice-design prompt; OpenClaw supplies a default when omitted.</ParamField>
  </Accordion>
</AccordionGroup>
