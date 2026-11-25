---
summary: "Use OpenAI via API keys or Codex subscription in OpenClaw"
read_when:
  - You want to use OpenAI models in OpenClaw
  - You want Codex subscription auth instead of API keys
  - You want Astra async tools, mid-turn steering, or cached reasoning changes
  - You need stricter GPT-5 agent execution behavior
title: "OpenAI"
---

OpenClaw uses one provider id, `openai`, for both direct API-key auth and
ChatGPT/Codex subscription auth. `openai/*` is the standard model route.
For embedded agent turns with runtime policy unset or `auto`, OpenAI's route
facts decide whether OpenClaw may select the bundled Codex app-server runtime
implicitly. The `openai/*` prefix alone does not select a runtime.

- **Agent models** - `openai/*` through the runtime selected by explicit
  `agentRuntime` config or OpenAI's implicit route policy. Sign in with Codex
  auth for ChatGPT/Codex subscription use, or configure an API-key auth
  profile when you want key-based billing.
- **Non-agent OpenAI APIs** - direct OpenAI Platform access, billed per use,
  through `OPENAI_API_KEY` or an `openai` API-key auth profile.
- **Legacy config** - `codex/*` and `openai-codex/*` refs are repaired to
  `openai/*` plus model-scoped `agentRuntime.id: "codex"` by
  `openclaw doctor --fix`.

OpenAI explicitly supports subscription OAuth usage in external tools and
workflows like OpenClaw.

This page is an index. OpenAI is documented on nine pages, one per reader
job. Open the page that matches your task.

| Page                                                            | Read it when                                                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenAI setup](/providers/openai/setup)                         | You are connecting an account: the API-key and Codex subscription paths, route summaries, OAuth recovery, and the long-context opt-in. |
| [OpenAI authentication](/providers/openai/authentication)       | Choose Codex login, an API key, or SIWC based on model access, plugins, usage tracking, and permissions.                               |
| [OpenAI models](/providers/openai/models)                       | You are choosing a model ref: the quick-choice table, GPT-6 Astra, Sol, Luna, and the GPT-5.6 tiers.                                   |
| [OpenAI runtimes and Codex auth](/providers/openai/runtimes)    | You need to know which runtime runs an `openai/*` turn, and how native Codex resolves its account.                                     |
| [OpenAI coverage and cost](/providers/openai/coverage-and-cost) | You want the capability matrix, memory embeddings, or how subscription quota and Platform billing are reported.                        |
| [OpenAI image generation](/providers/openai/image-and-video)    | You are generating or editing images through the bundled `openai` plugin.                                                              |
| [OpenAI voice and speech](/providers/openai/voice-and-speech)   | You are configuring text-to-speech, transcription, or realtime voice, including per-route auth order.                                  |
| [Azure OpenAI endpoints](/providers/openai/azure)               | You are pointing the bundled `openai` provider at an Azure OpenAI resource.                                                            |
| [OpenAI advanced configuration](/providers/openai/advanced)     | You are tuning prompt contribution, transport, Fast mode, compaction, strict-agentic mode, or proxy compat.                            |

## Where each section moved

Every anchor the single-page version published still resolves here, so an
existing link such as `/providers/openai#implicit-agent-runtime` keeps
working. Each entry points at the page that now holds the content.

**[OpenAI setup](/providers/openai/setup)**

- <a id="getting-started" />[Getting started](/providers/openai/setup#getting-started)
- <a id="route-summary" />[Route summary](/providers/openai/setup#route-summary)
- <a id="config-example" />[Config example](/providers/openai/setup#config-example)
- <a id="route-summary-1" /><a id="route-summary-2" />[Route summary](/providers/openai/setup#route-summary-2)
- <a id="config-example-1" /><a id="config-example-2" />[Config example](/providers/openai/setup#config-example-2)
- <a id="check-and-recover-codex-oauth-routing" />[Check and recover Codex OAuth routing](/providers/openai/setup#check-and-recover-codex-oauth-routing)
- <a id="status-indicator" />[Status indicator](/providers/openai/setup#status-indicator)
- <a id="doctor-warning" />[Doctor warning](/providers/openai/setup#doctor-warning)
- <a id="context-window-defaults-and-long-context-opt-in" />[Context window defaults and long-context opt-in](/providers/openai/setup#context-window-defaults-and-long-context-opt-in)
- <a id="embedded-openclaw-translation" />[Embedded OpenClaw translation](/providers/openai/setup#embedded-openclaw-translation)
- <a id="native-codex-translation" />[Native Codex translation](/providers/openai/setup#native-codex-translation)
- <a id="catalog-recovery" />[Catalog recovery](/providers/openai/setup#catalog-recovery)
- <a id="api-key-openai-platform" />[API key (OpenAI Platform)](/providers/openai/setup#api-key-openai-platform)
- <a id="get-your-api-key" />[Get your API key](/providers/openai/setup#get-your-api-key)
- <a id="run-onboarding" />[Run onboarding](/providers/openai/setup#run-onboarding)
- <a id="verify-the-model-is-available" />[Verify the model is available](/providers/openai/setup#verify-the-model-is-available)
- <a id="codex-subscription" />[Codex subscription](/providers/openai/setup#codex-subscription)
- <a id="run-codex-oauth" />[Run Codex OAuth](/providers/openai/setup#run-codex-oauth)
- <a id="use-the-canonical-openai-model-route" />[Use the standard OpenAI model route](/providers/openai/setup#use-the-canonical-openai-model-route)
- <a id="verify-codex-auth-is-available" />[Verify Codex auth is available](/providers/openai/setup#verify-codex-auth-is-available)

**[OpenAI models](/providers/openai/models)**

- <a id="quick-choice" />[Quick choice](/providers/openai/models#quick-choice)
- <a id="retired-subscription-model-references" />[Retired subscription model references](/providers/openai/models#retired-subscription-model-references)
- <a id="gpt-6-astra" />[GPT-6 Astra](/providers/openai/models#gpt-6-astra)
- <a id="async-tools%2C-steering%2C-and-reasoning-changes" /><a id="async-tools-steering-and-reasoning-changes" />[Async tools, steering, and reasoning changes](/providers/openai/models#async-tools-steering-and-reasoning-changes)
- <a id="gpt-5.6-limited-preview" /><a id="gpt-5-6-limited-preview" />[GPT-5.6 limited preview](/providers/openai/models#gpt-5-6-limited-preview)

**[OpenAI runtimes and Codex auth](/providers/openai/runtimes)**

- <a id="naming-map" />[Naming map](/providers/openai/runtimes#naming-map)
- <a id="implicit-agent-runtime" />[Implicit agent runtime](/providers/openai/runtimes#implicit-agent-runtime)
- <a id="native-codex-app-server-auth" />[Native Codex app-server auth](/providers/openai/runtimes#native-codex-app-server-auth)

**[OpenAI coverage and cost](/providers/openai/coverage-and-cost)**

- <a id="usage-and-cost-tracking" />[Usage and cost tracking](/providers/openai/coverage-and-cost#usage-and-cost-tracking)
- <a id="openclaw-feature-coverage" />[OpenClaw feature coverage](/providers/openai/coverage-and-cost#openclaw-feature-coverage)
- <a id="memory-embeddings" />[Memory embeddings](/providers/openai/coverage-and-cost#memory-embeddings)

**[OpenAI image generation](/providers/openai/image-and-video)**

- <a id="image-generation" />[Image generation](/providers/openai/image-and-video#image-generation)
- <a id="video-generation" />[Supported video providers](/tools/video-generation)

**[OpenAI voice and speech](/providers/openai/voice-and-speech)**

- <a id="voice-and-speech" />[Voice and speech](/providers/openai/voice-and-speech#voice-and-speech)
- <a id="gateway-controlled-realtime-call-cleanup" />[Gateway-controlled Realtime call cleanup](/providers/openai/voice-and-speech#gateway-controlled-realtime-call-cleanup)
- <a id="ga-realtime-browser-authentication" />[GA Realtime browser authentication](/providers/openai/voice-and-speech#ga-realtime-browser-authentication)
- <a id="released-gpt-live-browser-and-gateway-relay-authentication" />[Released GPT-Live browser and Gateway relay authentication](/providers/openai/voice-and-speech#released-gpt-live-browser-and-gateway-relay-authentication)
- <a id="unlisted-and-private-realtime-transport-paths" />[Unlisted and private realtime transport paths](/providers/openai/voice-and-speech#unlisted-and-private-realtime-transport-paths)
- <a id="speech-synthesis-tts" />[Speech synthesis (TTS)](/providers/openai/voice-and-speech#speech-synthesis-tts)
- <a id="speech-to-text" />[Speech-to-text](/providers/openai/voice-and-speech#speech-to-text)
- <a id="realtime-transcription" />[Realtime transcription](/providers/openai/voice-and-speech#realtime-transcription)
- <a id="realtime-voice" />[Realtime voice](/providers/openai/voice-and-speech#realtime-voice)

**[Azure OpenAI endpoints](/providers/openai/azure)**

- <a id="azure-openai-endpoints" />[Azure OpenAI endpoints](/providers/openai/azure#azure-openai-endpoints)
- <a id="configuration" />[Configuration](/providers/openai/azure#configuration)
- <a id="api-version" />[API version](/providers/openai/azure#api-version)
- <a id="model-names-are-deployment-names" />[Model names are deployment names](/providers/openai/azure#model-names-are-deployment-names)
- <a id="regional-availability" />[Regional availability](/providers/openai/azure#regional-availability)
- <a id="parameter-differences" />[Parameter differences](/providers/openai/azure#parameter-differences)

**[OpenAI advanced configuration](/providers/openai/advanced)**

- <a id="gpt-5-prompt-contribution" />[GPT-5 prompt contribution](/providers/openai/advanced#gpt-5-prompt-contribution)
- <a id="advanced-configuration" />[Advanced configuration](/providers/openai/advanced#advanced-configuration)
- <a id="config" />[Config](/providers/openai/advanced#config)
- <a id="cli" />[CLI](/providers/openai/advanced#cli)
- <a id="transport-websocket-vs-sse" />[Transport (WebSocket vs SSE)](/providers/openai/advanced#transport-websocket-vs-sse)
- <a id="fast-mode" />[Fast mode](/providers/openai/advanced#fast-mode)
- <a id="openai-api-fast-mode-with-service-tier" />[OpenAI API Fast mode with service_tier](/providers/openai/advanced#openai-api-fast-mode-with-service-tier)
- <a id="server-side-compaction-responses-api" />[Server-side compaction (Responses API)](/providers/openai/advanced#server-side-compaction-responses-api)
- <a id="enable-explicitly" />[Enable explicitly](/providers/openai/advanced#enable-explicitly)
- <a id="custom-threshold" />[Custom threshold](/providers/openai/advanced#custom-threshold)
- <a id="disable" />[Disable](/providers/openai/advanced#disable)
- <a id="strict-agentic-gpt-mode" />[Strict-agentic GPT mode](/providers/openai/advanced#strict-agentic-gpt-mode)
- <a id="native-vs-openai-compatible-routes" />[Native vs OpenAI-compatible routes](/providers/openai/advanced#native-vs-openai-compatible-routes)

## Related

For hosted execution, file handling, and connected tools in chat, see the
[Agents API guide](/plugins/agentsapi).

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Image generation" href="/tools/image-generation" icon="image">
    Shared image tool parameters and provider selection.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="OAuth and auth" href="/gateway/authentication" icon="key">
    Auth details and credential reuse rules.
  </Card>
</CardGroup>

## Decision models

The bundled `openai` plugin supports the beta
[OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions)
through OpenClaw's [Decision model role](/concepts/decision-models).
Configure `OPENAI_API_KEY` or an `openai` API-key auth profile, then select
`openai/gpt-6-luna` in the Decision picker or set:

```json5
{
  agents: { defaults: { decisionModel: "openai/gpt-6-luna" } },
}
```

The account and selected model must have Decisions API access. OpenClaw requires
a Platform API key for Decisions. It excludes ChatGPT/Codex subscription profiles
and Sign in with ChatGPT token-sharing grants before credential resolution.
The provider selects the Decisions route before credential resolution. A model-level
`baseUrl` takes precedence over the provider URL, then `OPENAI_BASE_URL`, then
the Platform default. A custom Platform-compatible endpoint must implement
the native `POST /decisions` question and image contract; route metadata does not
validate a custom endpoint's implementation. Declare the supported model under
`models.providers.openai.models` when using a custom provider URL; implicit
native model discovery does not advertise models for arbitrary endpoints.
ChatGPT backend URLs are rejected. Prepared provider, model and request headers
retain their normal precedence. An explicit `@profile`
selection remains locked; an incompatible subscription profile does not fall
through to a different account.

Boolean questions map to predicates; choices retain their string labels; score
levels use zero-based rubric positions. A V2 batch supports up to 400 questions,
with up to 255 alternatives per choice question. Larger requests return
`unsupported-input` before credential resolution or an API call. Split independent
questions into separate batches, or reduce the alternatives. Legacy V1 callers
retain the host's 256-question limit; use `contractVersion: 2` for larger batches.

The prepared V2 adapter accepts tagged text, JSON, or one inline PNG, JPEG, or
WebP image up to 4 MiB, with optional text. It does not fetch remote image URLs.
Explicit JSON scalars and strings remain JSON-encoded; text remains literal.
Omitted reasoning and `reasoning: "auto"` preserve the endpoint default; explicit
`on` and `off` controls are unsupported.
Boolean, Choice, and Score questions work with image evidence. OpenClaw's
image envelope is an integration limit, not a claim about the vendor's maximum.

A per-question refusal becomes an error answer with `providerCode: "refusal"`;
successful siblings remain available. Malformed or incomplete answers return
`invalid-response`. Probabilities, fractional scores, confidence, and input/output
token usage are preserved. Decision cost stays unknown unless reported; chat
token prices do not price this endpoint. V1 text/JSON callers still use the
lossless bridge, so a refusal batch cannot be narrowed to V1.

Selecting a Decision model does not replace the primary chat model or enable
automatic Decision assistance. Explicit evaluations send the supplied evidence
to OpenAI and use Platform billing.

### Harness and authentication

Both the OpenClaw and Codex harnesses expose the shared `decision_evaluate` tool
when a Decision model is configured, subject to normal tool policy.
The OpenAI plugin sends its requests to
`POST /v1/decisions`. Codex's native model loop still uses Responses.

| Primary-model harness | Primary-model auth | Decision auth and behavior                                                                                                      |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw              | Platform API key   | The shared tool resolves a compatible OpenAI API key.                                                                           |
| OpenClaw              | ChatGPT OAuth      | The shared tool requires a separate OpenAI API-key profile or `OPENAI_API_KEY`.                                                 |
| Codex                 | Platform API key   | The shared tool resolves an OpenClaw OpenAI API key independently of Codex's native credentials.                                |
| Codex                 | ChatGPT OAuth      | Native Codex login remains available for chat. The shared tool requires an OpenClaw OpenAI API-key profile or `OPENAI_API_KEY`. |

With automatic OAuth-only discovery, an evaluation returns `credentials-unavailable`
without an API request. An explicitly incompatible provider credential binding
remains terminal; OpenClaw does not substitute another account. Configure the
Decision API key through OpenClaw's existing OpenAI auth setup, without changing
the primary model or Codex login.
