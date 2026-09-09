---
summary: "The provider hook order table, worked provider example, bundled hook shapes, and model catalog registration"
read_when:
  - Implementing provider runtime hooks
  - You need the hook order and the decision guide for a model provider plugin
  - You are publishing model catalog rows from a plugin
title: "Provider runtime hooks and catalogs"
sidebarTitle: "Provider hooks and catalogs"
---

The three provider layers, the full hook order table, a worked provider example,
the bundled hook shapes, and how provider catalogs merge. Part of the [Plugin
architecture internals](/plugins/architecture-internals) guide.

## Provider runtime hooks

Provider plugins have three layers:

- **Manifest metadata** for cheap pre-runtime lookup:
  `setup.providers[].envVars`, `providerAuthAliases`, `providerAuthChoices`,
  and `channelConfigs`.
- **Config-time hooks**: `catalog` plus `applyConfigDefaults`.
- **Runtime hooks**: 40+ optional hooks covering auth, model resolution,
  stream wrapping, thinking levels, replay policy, and usage endpoints. See
  [Hook order and usage](#hook-order-and-usage).

OpenClaw still owns the generic agent loop, failover, transcript handling, and
tool policy. These hooks are the extension surface for provider-specific
behavior without needing a whole custom inference transport.

Hook lookup uses the prepared generation or a matching loaded registry first.
On a miss, provider/model-scoped discovery reuses the loader's registry cache;
explicit runtime-discovery invalidation clears that lookup rather than leaving
another provider cache holding old hooks. Attempt-prepared provider handles
retain their selected plugin, while each hook receives the current call context.

Use manifest `setup.providers[].envVars` when the provider has env-based
credentials that generic auth/status/model-picker paths should see without
loading plugin runtime. Use manifest `providerAuthAliases`
when one provider id should reuse another provider id's env vars, auth profiles,
config-backed auth, and API-key onboarding choice. Use manifest
`providerAuthChoices` when onboarding/auth-choice CLI surfaces should know the
provider's choice id, group labels, and simple one-flag auth wiring without
loading provider runtime. Keep provider runtime
`envVars` for operator-facing hints such as onboarding labels or OAuth
client-id/client-secret setup vars.

Describe env-driven channel setup and auth through the owning
`channelConfigs.<id>.schema` and setup descriptors.

### Hook order and usage

For model/provider plugins, OpenClaw calls hooks in this rough order.
The "When to use" column is the quick decision guide.
Compatibility-only provider fields that OpenClaw no longer calls, such as
`ProviderPlugin.capabilities` and `suppressBuiltInModel`, are intentionally not
listed here.

| Hook                              | What it does                                                                                                   | When to use                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog`                         | Publish provider config into `models.providers` during `models.json` generation                                | Provider owns a catalog or base URL defaults                                                                                                  |
| `applyConfigDefaults`             | Apply provider-owned global config defaults during config materialization                                      | Defaults depend on auth mode, env, or provider model-family semantics                                                                         |
| _(built-in model lookup)_         | OpenClaw tries the normal registry/catalog path first                                                          | _(not a plugin hook)_                                                                                                                         |
| `normalizeModelId`                | Normalize legacy or preview model-id aliases before lookup                                                     | Provider owns alias cleanup before canonical model resolution                                                                                 |
| `normalizeTransport`              | Normalize provider-family `api` / `baseUrl` before generic model assembly                                      | Provider owns transport cleanup for custom provider ids in the same transport family                                                          |
| `normalizeConfig`                 | Normalize `models.providers.<id>` before runtime/provider resolution                                           | Provider needs config cleanup that should live with the owning plugin                                                                         |
| `applyNativeStreamingUsageCompat` | Apply native streaming-usage compat rewrites to config providers                                               | Provider needs endpoint-driven native streaming usage metadata fixes                                                                          |
| `resolveConfigApiKey`             | Resolve env-marker auth for config providers before runtime auth loading                                       | Providers expose their own env-marker API-key resolution hooks                                                                                |
| `resolveSyntheticAuth`            | Surface local/self-hosted or config-backed auth without persisting plaintext                                   | Provider can operate with a synthetic/local credential marker                                                                                 |
| `resolveExternalAuthProfiles`     | Overlay provider-owned external auth profiles; default `persistence` is `runtime-only` for CLI/app-owned creds | Provider reuses external auth credentials without persisting copied refresh tokens; declare `contracts.externalAuthProviders` in the manifest |
| `shouldDeferSyntheticProfileAuth` | Lower stored synthetic profile placeholders behind env/config-backed auth                                      | Provider stores synthetic placeholder profiles that should not win precedence                                                                 |
| `resolveDynamicModel`             | Sync fallback for provider-owned model ids not in the local registry yet                                       | Provider accepts arbitrary upstream model ids                                                                                                 |
| `prepareDynamicModel`             | Return an asynchronously prepared model, or warm reusable metadata before retrying `resolveDynamicModel`       | Provider needs network metadata before resolving unknown ids                                                                                  |
| `normalizeResolvedModel`          | Final rewrite before the embedded runner uses the resolved model                                               | Provider needs transport rewrites but still uses a core transport                                                                             |
| `normalizeToolSchemas`            | Normalize tool schemas before the embedded runner sees them                                                    | Provider needs transport-family schema cleanup                                                                                                |
| `inspectToolSchemas`              | Surface provider-owned schema diagnostics after normalization                                                  | Provider wants keyword warnings without teaching core provider-specific rules                                                                 |
| `resolveReasoningOutputMode`      | Select native vs tagged reasoning-output contract                                                              | Provider needs tagged reasoning/final output instead of native fields                                                                         |
| `prepareExtraParams`              | Request-param normalization before generic stream option wrappers                                              | Provider needs default request params or per-provider param cleanup                                                                           |
| `createStreamFn`                  | Fully replace the normal stream path with a custom transport                                                   | Provider needs a custom wire protocol, not just a wrapper                                                                                     |
| `wrapStreamFn`                    | Stream wrapper after generic wrappers are applied                                                              | Provider needs request headers/body/model compat wrappers without a custom transport                                                          |
| `reconcileLocalService`           | Reconcile provider-owned state after local-service health and before every request                             | A managed local router must reload durable provider state without moving provider policy into core                                            |
| `resolveTransportTurnState`       | Attach native per-turn headers, metadata, or WebSocket policy                                                  | Provider wants generic transports to send provider-native turn identity or tune WebSocket headers and fallback cool-down                      |
| `resolveWebSocketSessionPolicy`   | Deprecated compatibility hook for WebSocket policy                                                             | Existing plugins migrate WebSocket fields into `resolveTransportTurnState`                                                                    |
| `formatApiKey`                    | Auth-profile formatter: stored profile becomes the runtime `apiKey` string                                     | Provider stores extra auth metadata and needs a custom runtime token shape                                                                    |
| `refreshOAuth`                    | OAuth refresh override for custom refresh endpoints or refresh-failure policy                                  | Provider does not fit the shared OpenClaw refreshers                                                                                          |
| `buildAuthDoctorHint`             | Repair hint appended when OAuth refresh fails                                                                  | Provider needs provider-owned auth repair guidance after refresh failure                                                                      |
| `matchesContextOverflowError`     | Provider-owned context-window overflow matcher                                                                 | Provider has raw overflow errors generic heuristics would miss                                                                                |
| `classifyFailoverReason`          | Provider-owned failover reason classification                                                                  | Provider can map raw API/transport errors to rate-limit/overload/etc                                                                          |
| `isCacheTtlEligible`              | Prompt-cache policy for proxy/backhaul providers                                                               | Provider needs proxy-specific cache TTL gating                                                                                                |
| `buildMissingAuthMessage`         | Replacement for the generic missing-auth recovery message                                                      | Provider needs a provider-specific missing-auth recovery hint                                                                                 |
| `augmentModelCatalog`             | Synthetic/final catalog rows appended after discovery (deprecated, see below)                                  | Provider needs synthetic forward-compat rows in `models list` and pickers                                                                     |
| `resolveThinkingProfile`          | Model-specific `/think` level set, display labels, and default                                                 | Provider exposes a custom thinking ladder or binary label for selected models                                                                 |
| `isBinaryThinking`                | On/off reasoning toggle compatibility hook                                                                     | Provider exposes only binary thinking on/off                                                                                                  |
| `supportsXHighThinking`           | `xhigh` reasoning support compatibility hook                                                                   | Provider wants `xhigh` on only a subset of models                                                                                             |
| `resolveDefaultThinkingLevel`     | Default `/think` level compatibility hook                                                                      | Provider owns default `/think` policy for a model family                                                                                      |
| `isModernModelRef`                | Modern-model matcher for live profile filters and smoke selection                                              | Provider owns live/smoke preferred-model matching                                                                                             |
| `prepareRuntimeAuth`              | Exchange a configured credential into the actual runtime token/key just before inference                       | Provider needs a token exchange or short-lived request credential                                                                             |
| `resolveUsageAuth`                | Resolve usage/billing credentials for `/usage` and related status surfaces                                     | Provider needs custom usage/quota token parsing or a different usage credential                                                               |
| `fetchUsageSnapshot`              | Fetch and normalize provider-specific usage/quota snapshots after auth is resolved                             | Provider needs a provider-specific usage endpoint or payload parser                                                                           |
| `createEmbeddingProvider`         | Build a provider-owned embedding adapter for memory/search                                                     | Memory embedding behavior belongs with the provider plugin                                                                                    |
| `buildReplayPolicy`               | Return a replay policy controlling transcript handling for the provider                                        | Provider needs custom transcript policy (for example, thinking-block stripping)                                                               |
| `sanitizeReplayHistory`           | Rewrite replay history after generic transcript cleanup                                                        | Provider needs provider-specific replay rewrites beyond shared compaction helpers                                                             |
| `validateReplayTurns`             | Final replay-turn validation or reshaping before the embedded runner                                           | Provider transport needs stricter turn validation after generic sanitation                                                                    |
| `onModelSelected`                 | Run provider-owned post-selection side effects                                                                 | Provider needs telemetry or provider-owned state when a model becomes active                                                                  |

`reconcileLocalService` runs only for configured local services, including a
healthy process reused from outside the current Gateway process. Keep it cheap,
idempotent, and abort-aware. A rejection blocks the provider request and
releases its lease without classifying the healthy process as a startup failure.

Normalization dispatch is hook-specific:

- Model references apply manifest-declared model-ID normalization once before
  `normalizeModelId` dispatch. The matched provider hook can refine that prepared
  model ID; an empty result keeps it unchanged. OpenClaw does not try other
  providers' normalization hooks or reapply manifest rules afterward.
  Reference parsing reads the selected runtime registry without activating
  plugins. Executable normalization requires a prepared runtime owner; reads
  without one use static manifest policies only.
  A directly registered provider owns its ID; compatibility aliases match only
  when no literal provider exists, preserving alias-only routes and explicit
  API-owner eligibility.
- `normalizeTransport` tries the matched provider first. Only if that does not
  change `api` or `baseUrl` and the provider has no `models.providers.<id>` entry
  does it try other transport hooks, stopping at the first change.
- `normalizeConfig` uses the owning bundled provider's lightweight policy surface
  first. If that surface has no `normalizeConfig` hook, OpenClaw may call the
  matched runtime owner, provided runtime loading is allowed and, when a config
  is supplied, that owner has explicit plugin activation. It never scans other
  providers' hooks or falls through after the owning hook returns no change.
  Config assembly passes `allowRuntimePluginLoad: false`, so it uses bundled
  policy without loading provider runtime.

Google-family config cleanup is implemented by the Google plugin's own
`normalizeConfig` hook, shared with its lightweight policy surface. It is not a
separate core compatibility backstop.

If the provider needs a fully custom wire protocol or custom request executor,
that is a different class of extension. These hooks are for provider behavior
that still runs on OpenClaw's normal inference loop.

`resolveUsageAuth` decides whether OpenClaw should call `fetchUsageSnapshot` or
fall back to generic credential resolution for usage/status surfaces. Return
`{ token, accountId?, subscriptionType?, rateLimitTier? }` when the provider
has a usage credential (the optional plan metadata flows into
`fetchUsageSnapshot`), return
`{ handled: true }` when provider-owned usage auth has handled the request and
must suppress generic API-key/OAuth fallback, and return `null` or `undefined`
when the provider did not handle usage auth.

Declare organization or billing credentials in manifest
`providerUsageAuthEnvVars`. This lets generic discovery and secret-scrubbing
surfaces recognize them without making them inference auth candidates.

### Provider example

```ts
api.registerProvider({
  id: "example-proxy",
  label: "Example Proxy",
  auth: [],
  catalog: {
    order: "simple",
    run: async (ctx) => {
      const apiKey = ctx.resolveProviderApiKey("example-proxy").apiKey;
      if (!apiKey) {
        return null;
      }
      return {
        provider: {
          baseUrl: "https://proxy.example.com/v1",
          apiKey,
          api: "openai-completions",
          models: [{ id: "auto", name: "Auto" }],
        },
      };
    },
  },
  resolveDynamicModel: (ctx) => ({
    id: ctx.modelId,
    name: ctx.modelId,
    provider: "example-proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }),
  prepareRuntimeAuth: async (ctx) => {
    const exchanged = await exchangeToken(ctx.apiKey);
    return {
      apiKey: exchanged.token,
      baseUrl: exchanged.baseUrl,
      expiresAt: exchanged.expiresAt,
    };
  },
  resolveUsageAuth: async (ctx) => {
    const auth = await ctx.resolveOAuthToken();
    return auth ? { token: auth.token } : null;
  },
  fetchUsageSnapshot: async (ctx) => {
    return await fetchExampleProxyUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
  },
});
```

### Built-in examples

Bundled provider plugins combine the hooks above to fit each vendor's catalog,
auth, thinking, replay, and usage needs. The authoritative hook set lives with
each plugin under `extensions/`; this page illustrates the shapes rather than
mirroring the list.

<AccordionGroup>
  <Accordion title="Pass-through catalog providers">
    OpenRouter, Kilocode, Z.AI, xAI register `catalog` plus
    `resolveDynamicModel` / `prepareDynamicModel` so they can surface upstream
    model ids ahead of OpenClaw's static catalog.
  </Accordion>
  <Accordion title="OAuth and usage endpoint providers">
    GitHub Copilot, Gemini CLI, ChatGPT Codex, MiniMax, Xiaomi, z.ai pair
    `prepareRuntimeAuth` or `formatApiKey` with `resolveUsageAuth` +
    `fetchUsageSnapshot` to own token exchange and `/usage` integration.
  </Accordion>
  <Accordion title="Replay and transcript cleanup families">
    Shared named families (`google-gemini`, `passthrough-gemini`,
    `anthropic-by-model`, `hybrid-anthropic-openai`) let providers opt into
    transcript policy via `buildReplayPolicy` instead of each plugin
    re-implementing cleanup.
  </Accordion>
  <Accordion title="Catalog-only providers">
    `byteplus`, `cloudflare-ai-gateway`, `huggingface`, `kimi-coding`, `nvidia`,
    `qianfan`, `synthetic`, `together`, `venice`, `vercel-ai-gateway`, and
    `volcengine` register just `catalog` and ride the shared inference loop.
  </Accordion>
  <Accordion title="Anthropic-specific stream helpers">
    Beta headers, `/fast` / `serviceTier`, and `context1m` live inside the
    Anthropic plugin's public `api.ts` / `contract-api.ts` seam
    (`wrapAnthropicProviderStream`, `resolveAnthropicBetas`,
    `resolveAnthropicFastMode`, `resolveAnthropicServiceTier`) rather than in
    the generic SDK.
  </Accordion>
</AccordionGroup>

## Provider catalogs

Provider plugins can define model catalogs for inference with
`registerProvider({ catalog: { run(...) { ... } } })`.

`catalog.run(...)` returns the same shape OpenClaw writes into
`models.providers`:

- `{ provider }` for one provider entry
- `{ providers }` for multiple provider entries

Use `catalog` when the plugin owns provider-specific model ids, base URL
defaults, or auth-gated model metadata.

`catalog.order` controls when a plugin's catalog merges relative to OpenClaw's
built-in implicit providers:

- `simple`: plain API-key or env-driven providers
- `profile`: providers that appear when auth profiles exist
- `paired`: providers that synthesize multiple related provider entries
- `late`: last pass, after other implicit providers

Later providers win on key collision, so plugins can intentionally override a
built-in provider entry with the same provider id.

Plugins can also publish read-only model rows through
`api.registerModelCatalogProvider({ provider, kinds, staticCatalog, liveCatalog
})`. This is the forward path for list/help/picker surfaces and supports
`text`, `voice`, `image_generation`, `video_generation`, and `music_generation`
rows. Provider plugins still own live endpoint calls, token exchange, and
vendor response mapping; core owns the common row shape, source labels, and
media tool help formatting. Media-generation provider registrations synthesize
static catalog rows automatically from `defaultModel`, `models`, and
`capabilities`.

Compatibility:

- `discovery` still works as a legacy alias, but emits a deprecation warning
- if both `catalog` and `discovery` are registered, OpenClaw uses `catalog`
  and emits a warning
- `augmentModelCatalog` is deprecated; bundled providers should publish
  supplemental rows through `registerModelCatalogProvider`
