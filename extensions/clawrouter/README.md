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

Choose `clawrouter` as the memory embedding provider and select an eligible catalog
model. Each call resolves the router credential and refreshes declared formats.
OpenAI-format text embeddings retain native, manifest and unified transports.
Native formats use only native/manifest offers with the embedding capability:

| Wire format                                           | Qualified client surface                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `voyage.embeddings`                                   | voyage-4-large, voyage-4, voyage-4-lite; text query/document; float vectors at 256/512/1024/2048 dimensions                                      |
| `cohere.embed`                                        | embed-v4.0; text query/document; float vectors at 256/512/1024/1536 dimensions                                                                   |
| `aws_bedrock.invoke`                                  | Frozen Titan, Cohere, Nova and Marengo embedding families; text only, exact model/profile identity and family dimensions                         |
| `google.embed_content`, `google.batch_embed_contents` | gemini-embedding-001 and the two frozen Embedding 2 variants; task formatting, bounded synchronous batches and qualified inline multimodal parts |

Google Embedding 001 accepts text only. Embedding 2 preserves one aggregated
vector per input, including inline parts, and skips native text templates when
the host already prepared the input. Only declared, known formats enable a
request; these handlers neither create catalog offers nor activate Worker routes.
Google format declarations and Bedrock embedding offers still require their
schema/runtime owners' qualification.

Direct providers and ClawRouter share the native client builders and vector
readers. Every response batch must have complete, finite vectors with the admitted
count and dimensions. The consumer stages split batches until all requests succeed.
Dimension/task/input settings partition index identity. Credential refresh,
cancellation, one 30-second deadline, bounded response bytes and SSRF controls
remain active. Remote origin overrides require separately admitted router
credentials; upstream provider keys are never used.

Only provider-reported token usage is forwarded. Missing usage remains unknown;
vector dimensions never imply token count or cost. No tariff or billing policy
is created by this client. Async Google upload/batch/file APIs require original-job
ownership controls and remain disabled here; synchronous batches are not proof of
that lifecycle. Actual memory-to-Worker acceptance remains a separate integration
gate before claiming provider parity.

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
