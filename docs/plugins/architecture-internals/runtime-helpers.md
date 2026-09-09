---
summary: "Calling core speech, media understanding, subagent, web search, and image generation helpers from a plugin"
read_when:
  - You are calling core TTS, media understanding, subagent, or web search helpers from a plugin
  - You are registering a speech, media understanding, or web search provider
  - You need the ownership split between core orchestration and vendor behavior
title: "Core runtime helpers"
sidebarTitle: "Core runtime helpers"
---

What `api.runtime` exposes to plugin code, and the ownership rules for the
matching provider registrations. Part of the [Plugin architecture
internals](/plugins/architecture-internals) guide.

## Runtime helpers

Plugins can access selected core helpers via `api.runtime`. For TTS:

```ts
const clip = await api.runtime.tts.textToSpeech({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

const voices = await api.runtime.tts.listVoices({
  provider: "elevenlabs",
  cfg: api.config,
});
```

Notes:

- `textToSpeech` returns the normal core TTS output payload for file/voice-note surfaces.
- Uses core `tts` configuration and provider selection.
- Returns PCM audio buffer + sample rate. Plugins must resample/encode for providers.
- `listVoices` is optional per provider. Use it for vendor-owned voice pickers or setup flows.
- Core passes a resolved request deadline to provider `listVoices` hooks; provider-specific timeout settings may override it.
- Voice listings can include richer metadata such as locale, gender, and personality tags for provider-aware pickers.
- OpenAI and ElevenLabs support telephony today. Microsoft does not.

Plugins can also register speech providers via `api.registerSpeechProvider(...)`.

```ts
api.registerSpeechProvider({
  id: "acme-speech",
  label: "Acme Speech",
  isConfigured: ({ config }) => Boolean(config.messages?.tts),
  synthesize: async (req) => {
    return {
      audioBuffer: Buffer.from([]),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    };
  },
});
```

Notes:

- Keep TTS policy, fallback, and reply delivery in core.
- Use speech providers for vendor-owned synthesis behavior.
- Legacy Microsoft `edge` input is normalized to the `microsoft` provider id.
- The preferred ownership model is company-oriented: one vendor plugin can own
  text, speech, image, and future media providers as OpenClaw adds those
  capability contracts.

For image/audio/video understanding, plugins register one typed
media-understanding provider instead of a generic key/value bag:

```ts
api.registerMediaUnderstandingProvider({
  id: "google",
  capabilities: ["image", "audio", "video"],
  describeImage: async (req) => ({ text: "..." }),
  transcribeAudio: async (req) => ({ text: "..." }),
  describeVideo: async (req) => ({ text: "..." }),
});
```

Notes:

- Keep orchestration, fallback, config, and channel wiring in core.
- Keep vendor behavior in the provider plugin.
- Additive expansion should stay typed: new optional methods, new optional
  result fields, new optional capabilities.
- Video generation already follows the same pattern:
  - core owns the capability contract and runtime helper
  - vendor plugins register `api.registerVideoGenerationProvider(...)`
  - feature/channel plugins consume `api.runtime.videoGeneration.*`

For media-understanding runtime helpers, plugins can call:

```ts
const image = await api.runtime.mediaUnderstanding.describeImageFile({
  filePath: "/tmp/inbound-photo.jpg",
  cfg: api.config,
  agentDir: "/tmp/agent",
});

const video = await api.runtime.mediaUnderstanding.describeVideoFile({
  filePath: "/tmp/inbound-video.mp4",
  cfg: api.config,
});

const extraction = await api.runtime.mediaUnderstanding.extractStructuredWithModel({
  provider: "codex",
  model: "gpt-5.6-sol",
  input: [
    {
      type: "image",
      buffer: receiptImageBuffer,
      fileName: "receipt.png",
      mime: "image/png",
    },
    { type: "text", text: "Use the printed fields as the source of truth." },
  ],
  instructions: "Return entities and searchable tags.",
  schemaName: "example.evidence",
  jsonSchema: {
    type: "object",
    properties: {
      entities: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
    },
  },
  cfg: api.config,
});
```

For audio transcription, plugins can use either the media-understanding runtime
or the older STT alias:

```ts
const { text } = await api.runtime.mediaUnderstanding.transcribeAudioFile({
  filePath: "/tmp/inbound-audio.ogg",
  cfg: api.config,
  // Optional when MIME cannot be inferred reliably:
  mime: "audio/ogg",
});
```

Notes:

- `api.runtime.mediaUnderstanding.*` is the preferred shared surface for
  image/audio/video understanding.
- `extractStructuredWithModel(...)` is the plugin-facing seam for bounded
  provider-owned image-first extraction. Include at least one image input;
  text inputs are supplemental context. Product plugins own their routes and
  schemas while OpenClaw owns the provider/runtime boundary.
- Uses core media-understanding audio configuration (`tools.media.audio`) and provider fallback order.
- Returns `{ text: undefined }` when no transcription output is produced (for example skipped/unsupported input).

Plugins can also launch background subagent runs through `api.runtime.subagent`:

```ts
const result = await api.runtime.subagent.run({
  sessionKey: "agent:main:subagent:search-helper",
  message: "Expand this query into focused follow-up searches.",
  toolsAlsoAllow: ["my_plugin_progress"],
  provider: "openai",
  model: "gpt-4.1-mini",
  deliver: false,
});
```

Notes:

- `provider` and `model` are optional per-run overrides, not persistent session changes.
- `toolsAlsoAllow` accepts exact, uniquely owned tool names registered by the calling plugin. Core and ambiguous names are rejected. It is additive to the normal profile, but operator allowlists and denies remain authoritative.
- OpenClaw only honors those override fields for trusted callers.
- For plugin-owned fallback runs, operators must opt in with `plugins.entries.<id>.subagent.allowModelOverride: true`.
- Use `plugins.entries.<id>.subagent.allowedModels` to restrict trusted plugins to specific canonical `provider/model` targets, or `"*"` to allow any target explicitly.
- Untrusted plugin subagent runs still work, but override requests are rejected instead of silently falling back.
- Plugin-created subagent sessions are tagged with the creating plugin id. Fallback `api.runtime.subagent.deleteSession(...)` may delete those owned sessions only; arbitrary session deletion still requires an admin-scoped Gateway request.

For web search, plugins can consume the shared runtime helper instead of
reaching into the agent tool wiring:

```ts
const providers = api.runtime.webSearch.listProviders({
  config: api.config,
});

const result = await api.runtime.webSearch.search({
  config: api.config,
  args: {
    query: "OpenClaw plugin runtime helpers",
    count: 5,
  },
});
```

Plugins can also register web-search providers via
`api.registerWebSearchProvider(...)`.

Notes:

- Keep provider selection, credential resolution, and shared request semantics in core.
- Use web-search providers for vendor-specific search transports.
- `api.runtime.webSearch.*` is the preferred shared surface for feature/channel plugins that need search behavior without depending on the agent tool wrapper.

### `api.runtime.imageGeneration`

```ts
const result = await api.runtime.imageGeneration.generate({
  config: api.config,
  args: { prompt: "A friendly lobster mascot", size: "1024x1024" },
});

const providers = api.runtime.imageGeneration.listProviders({
  config: api.config,
});
```

- `generate(...)`: generate an image using the configured image-generation provider chain.
- `listProviders(...)`: list available image-generation providers and their capabilities.
