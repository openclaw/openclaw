# ClawRouter

Managed multi-provider model routing and quota reporting for OpenClaw.

Chat discovery uses the selected endpoint's versioned native capability facts
for text/image input, context size, prompt threshold, and output ceiling. Facts
from another endpoint do not transfer to the selected transport. Audio, video,
and JSON input declarations do not enable those transports in chat. The router's
pricing output cap still bounds the requested output; older catalogs without
endpoint facts retain the existing fallback behavior.

Fusion is a virtual chat provider. Discovery accepts `clawrouter/fusion` at
`/v1/chat/completions` only when the selected key's catalog reports an executable,
eligible unified HTTP offer for that exact model and endpoint. Its `/v1` base is
not a native proxy prefix. Playground, denied, and unrelated offers cannot enable
the route. The service still checks current policy and compound budgets at dispatch.

Cohere chat discovery requires a key-scoped native offer whose declared request
and response format is `openai.chat_completions`. It uses that offer's exact
compatibility route, with the upstream model ID. Native and routed clients share
the Cohere instruction-role, tool-choice, and compatible wire-field policy.
Reasoning efforts remain owned by the router catalog. A native-v2-only catalog does not enable this
client transport; v2 routing and billed usage remain owned by the router.

Capability discovery joins eligible HTTP offers from the selected key's catalog
to the provider's declared endpoint formats. Native and manifest routes stay on
the configured router origin; model-less offers are valid for operations such as
search. A missing format, unsupported transport, playground offer, or unlisted
model is not executable. Consumers still implement only their known wire formats.
Discovery refreshes for each operation, shares its resolved credential with
dispatch, and uses a bounded, cancellable guarded request without upstream-key
fallback. Image generation uses this resolver; other consumers migrate separately.

Mistral chat routes share the native Mistral strict9 tool-call replay policy and
transport fields. Replayed tool calls use nine alphanumeric characters with paired
tool results; chat output uses `max_tokens` and does not send `store`. Reasoning
efforts remain owned by the router catalog. These rules apply to the Mistral
route, not another provider serving a similarly named model.

When `models.providers.clawrouter` is configured, the bundled plugin adds
**ClawRouter** to the Control UI sidebar. Its read-only pool dashboard shows
subscription quota windows, account and plan details, model eligibility,
extra usage, and traffic behind the configured key. **Refresh** fetches a new
snapshot. The ClawRouter policy must opt in to pool status visibility.

The plugin owns both the native browser bundle and the `clawrouter.pool.get`
Gateway method (`operator.read`). Credentials remain on the Gateway. Older
ClawRouter deployments, hidden policies, and unavailable or rejected credentials
show actionable status messages. The existing usage snapshot is unchanged.

See the [ClawRouter provider docs](https://docs.openclaw.ai/providers/clawrouter#pool-dashboard).

## Speech

The speech provider refreshes the selected key's catalog before each synthesis.
It consumes eligible HTTP offers declaring `openai.audio_speech` and `audio.binary`
through unified, native or manifest routes. Unknown formats and denied offers fail
before synthesis. Select the qualified voice model
`clawrouter/openai/tts-1` through `agents.defaults.voiceModel` or set
`tts.provider: "clawrouter"`. Speech-only catalog rows stay out of chat models.

Credentials resolve as **ClawRouter** auth for the `audio.speech` capability:
stored ClawRouter profiles, `models.providers.clawrouter.apiKey`,
`CLAWROUTER_API_KEY`, or an explicit `tts.providers.clawrouter.apiKey`.
An optional `tts.providers.clawrouter.profileId` locks selection to that stored
profile; missing, unavailable, or wrong-provider profiles fail without substituting
another key. An OpenAI key is never borrowed. The service still authorizes every
request against the selected key's current speech grants and budget; discovering
a model or finding a credential is not a grant.

`tts.providers.clawrouter` accepts an explicit catalog model, an OpenAI native
voice, optional `instructions`, `speed` (0.25–4),
and `responseFormat` (`mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`).
The default is MP3 for files and Opus for voice notes. Telephony always requests
signed 16-bit mono PCM at 24 kHz for the existing call transport conversion.
Input is limited to 4096 Unicode code points. The known client formats cover
`openai/tts-1`, `openai/tts-1-hd`, `openai/gpt-4o-mini-tts` and
`openai/gpt-4o-mini-tts-2025-12-15`; instructions apply only to the mini-TTS
models. This list does not grant or activate a router model. Select additional
models through `tts.providers.clawrouter.model` only when the current catalog
advertises an eligible offer. The static voice-model picker remains unchanged.

Talk uses `talk.provider: "clawrouter"` with the same credentials and format
settings under `talk.providers.clawrouter`; use `modelId: "openai/tts-1"` and
`speakerVoiceId` for its model and voice selections. Synthesis uses the normal
shared catalog/synthesis deadline and generated-audio size limit and returns service failures
rather than treating JSON error bodies as audio.

## Audio transcription

For batch/file transcription (including Talk file transcription), select
ClawRouter in the normal media configuration:

```json5
{
  tools: {
    media: {
      models: [{ provider: "clawrouter", model: "gpt-4o-transcribe", capabilities: ["audio"] }],
      audio: { enabled: true },
    },
  },
}
```

The adapter uses the configured ClawRouter origin and its native OpenAI
`/v1/native/openai/v1/audio/transcriptions` route. A base URL already ending in
that native `/v1` prefix is preserved. The configured model stays exactly
`gpt-4o-transcribe` (the qualified `openai/gpt-4o-transcribe` identity is also
accepted); no chat, Whisper, or upstream-key fallback is attempted. Credentials
come from canonical ClawRouter credential resolution. An entry’s `profile` locks
the selected ClawRouter profile. Custom transport, proxy, TLS, and private-network
policy remain governed by the shared HTTP transport.

Only nonstream JSON transcripts with optional language and prompt are supported.
Additional `providerOptions` fail explicitly rather than being silently dropped.
The normal media owner classifies MIME and trims prompt whitespace; the adapter
then preserves its file bytes, filename, effective MIME, language, and prompt.
AAC relabeling and unsafe filenames are rejected. File uploads are capped at
25,000,000 bytes; configured media byte/output limits can be lower.

An active or configured ClawRouter provider is also eligible for the existing
automatic audio selection. This is not an explicit-only adapter. Capability-less
shared chat/image entries do not opt into audio: use explicit audio capabilities
for shared transcription entries. Configured image-capable models retain
automatic, explicit, and shared image selection; native vision handoff is unchanged.
Authentication and configuration rejections can continue to another automatic
candidate before upload; missing credentials do not record a failed ClawRouter
attempt. An upload or HTTP failure stops automatic selection rather than sending
the same recording to another provider. In particular, a service `pricing_required`
response is not a reason to try a second provider.

A current service deployment with transcription support is required. Credential
availability does not prove per-key entitlement or budget admission. There is no
qualified whole-upload reserve ceiling for arbitrary files: hard-reserve requests
can return `pricing_required` before upstream dispatch. This adapter never changes
a policy to soft, fixed-price, or unmetered mode to make a request pass. Streaming,
diarization, other response formats/models, and realtime transcription remain
outside this adapter.

Speech request construction and frozen OpenAI model/voice facts are shared with
the native OpenAI plugin. The shared payload helper is an internal bundled-provider construction helper,
not a new typed public SDK API. Native auth, proxy capture and custom endpoint
behavior remain in the OpenAI plugin. The frozen speech SDK has no caller abort signal; deadlines
bound requests, but this bridge does not claim caller cancellation support.

## Memory embeddings

Choose `clawrouter` as the memory embedding provider and select a catalog model
such as `openai/text-embedding-3-small`. Each request resolves the router credential
and refreshes the catalog, then uses the eligible declared `openai.embeddings`
native, manifest or unified route. Native/manifest requests use the upstream model
ID; unified requests use the catalog ID. The existing memory transport validates
and orders vectors and reports usage.

The initial adapter supports default text embeddings at declared `/embeddings`
endpoints. Custom dimensions, task-specific input types and multimodal inputs fail
explicitly. Remote destination overrides retain the memory transport's separate
credential requirement; upstream OpenAI keys are never a fallback. A router
deployment that declares endpoint formats for the offered route is required.

## Web search

Set `tools.web.search.provider` to `clawrouter` to use the configured ClawRouter
credential. Each search resolves that credential and refreshes its catalog before
dispatch. Supported formats are `tavily.search`, `brave.search`, `exa.search`,
`parallel.search` and `searxng.search`, through eligible native or manifest offers
with matching declared methods and request/response formats. Brave and SearXNG
use GET query parameters; Exa, Parallel and Tavily use their native JSON bodies.
Brave, Exa, Parallel and SearXNG share their request/result codecs with the native
OpenClaw plugins.
Model-less offers are supported. The adapter does not infer `/v1/search`, use
upstream provider credentials, or execute undeclared formats. A router deployment
that includes endpoint format declarations for the selected offer is required.

Queries accept `query` and `count` (1–10). Catalog and search responses are bounded,
cancellation is propagated, and result text is marked as untrusted web content.

Parallel queries are limited to 200 characters. Native provider-specific advanced
filters are not exposed by this adapter. Request counters alone do not establish
USD prices or budget eligibility; catalog affordability and runtime admission
remain authoritative. Other declared search formats fail closed until a consumer
adapter and its transport fixtures are qualified.

## xAI Responses replay

Catalog-qualified xAI Responses models share the native tool-schema/argument
policy and encrypted reasoning include. Effort choices remain catalog-owned.
The real Responses transport captures and replays opaque reasoning within its
provider, model, origin, session and authentication-profile boundary. Grok CLI
OAuth identity headers are not applied to the router endpoint. Worker-side
upstream credential affinity and end-to-end replay remain separate requirements;
the client does not advertise an unlanded Responses route.
