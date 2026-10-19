---
summary: "Embedding, image and video generation, web fetch, and web search provider capabilities"
read_when:
  - You are registering an embedding provider for memory or search
  - You are adding image, video, or music generation to a provider plugin
  - You are wiring a web fetch or web search provider
title: "Provider media and search"
sidebarTitle: "Media and search"
---

Embedding, generation, and web capabilities a provider plugin can register
alongside text inference. Register each one inside `register(api)` next to
your existing `api.registerProvider(...)` call. Part of the [Building provider
plugins](/plugins/sdk-provider-plugins) guide.

Bundled runtime adapters can create deferred promises with `createDeferred` from
the private `openclaw/plugin-sdk/concurrency-runtime` subpath. It returns
`promise`, `resolve`, and `reject` without loading logging or provider auth;
the adapter retains responsibility for cancellation and terminal settlement.

Speech providers can use `createSpeechDirectiveParser` from the lightweight
`openclaw/plugin-sdk/speech-provider` subpath. Map each override field to its
policy key and accepted token aliases; optional field callbacks retain vendor
validation and warning text. The shared parser handles alias dispatch and policy
gating and returns an override patch. The host merges these patches into the
provider's accumulated overrides; callbacks use `currentOverrides` only when
merging a nested value such as voice settings.

## Media and search capabilities

<Tabs>
  <Tab title="Embeddings">
    ```typescript
    // fetchAcmeEmbedding is your plugin's own vendor API call, not an SDK export.
    api.registerEmbeddingProvider({
      id: "acme-ai",
      defaultModel: "acme-embed",
      transport: "remote",
      authProviderId: "acme-ai",
      create: async ({ model }) => ({
        provider: {
          id: "acme-ai",
          model,
          dimensions: 1536,
          embed: async (input) => {
            const text = typeof input === "string" ? input : input.text;
            return fetchAcmeEmbedding(text);
          },
          embedBatch: async (inputs) =>
            Promise.all(
              inputs.map((input) =>
                fetchAcmeEmbedding(typeof input === "string" ? input : input.text),
              ),
            ),
        },
      }),
    });
    ```

    Declare the same id in `contracts.embeddingProviders`. This is the
    general embedding contract for reusable vector generation, including
    memory search. The retired memory-specific registrar and manifest
    contract are no longer accepted.

    OpenAI-compatible endpoints can use `createRemoteEmbeddingProvider`
    from `openclaw/plugin-sdk/memory-core-host-engine-embeddings`. Its optional
    `buildRequestFields(kind)` callback returns extra JSON fields for
    `"query"` or `"document"` requests, such as `dimensions` or `input_type`.
    The shared factory always supplies the client's `model` and the original
    `input` array after those fields, preserving response-count validation.

    Clients returned by `resolveRemoteEmbeddingClient` resolve OAuth authorization
    through the auth-profile owner before each HTTP request. API keys and explicit
    authorization headers remain static. Pass the client's optional
    `resolveRequestHeaders` callback through batch helpers too: it receives
    `{ forceRefresh, signal }` and returns request headers. `withRemoteHttpResponse`
    applies those headers before guarded dispatch and supplies the actual headers
    as the second `onResponse` argument for error redaction. If that handler throws
    a provider HTTP error for `401 token_expired`, the helper releases the response,
    resolves headers once with `forceRefresh: true`, and retries only that request.
    Uploads must use a replayable body such as the batch helper's `FormData`.

    Embedding adapters can use `resolveEmbeddingProviderSsrFPolicy` from
    `openclaw/plugin-sdk/memory-core-host-engine-embeddings` to apply the shared model
    provider network policy. Pass the embedding provider ID, API, effective base URL,
    and configured `request.allowPrivateNetwork` value; reuse the returned policy for
    embedding requests and batch upload, status, and download requests.

    If an endpoint documents an input-array limit, set the optional
    `maxInputsPerRequest` field on the created provider instance. Use a positive
    safe integer for the selected endpoint and model; omit it when unknown.
    Memory caps inline embedding requests at that number before sending them,
    alongside its existing byte budget. Undeclared or stale limits still use
    reactive splitting when the endpoint reports a supported limit error.
    Invalid declarations are ignored. Provider batch jobs keep their own limits.

    The native OpenAI adapter declares [2048 inputs](https://developers.openai.com/api/reference/resources/embeddings/methods/create).
    A plugin serving Zhipu [embedding-3](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3)
    can declare 64; do not apply that limit to other models without documentation.
    Custom OpenAI-compatible endpoints stay undeclared. Bundled adapters using
    `createRemoteEmbeddingProvider` can pass the same field to that factory.
    This optional field preserves existing plugin contracts, index contents,
    and embedding-cache identities.

    `embed` and `embedBatch` accept an optional `onUsage` call option. A provider
    that reports usage calls it once per successful upstream request, before
    resolving, with `{ promptTokens, totalTokens }` or `undefined` when that
    response has no valid counts. Callers can sum these reports and treat any
    unavailable response as incomplete usage. The shared remote factory reports
    OpenAI-style usage; vector return values and existing plugins stay unchanged.

    Providers that accept model aliases can expose
    `normalizeModel(options): string`. Memory uses this synchronous hook for
    both creation options and cold index identity checks. Keep it configuration-only:
    do not authenticate or access the network. Make repeated normalization leave an already-normalized value unchanged, and
    reuse it in `create`, which may receive an already-normalized model or be
    called outside memory. Return an empty string only when the
    model remains unknown until discovery; do not turn an invalid explicit
    model into an omitted selection. For an exact pre-initialization identity,
    `resolveIndexIdentity(options)` additionally supplies the required
    `cacheKeyData` and any equivalent persisted aliases.

  </Tab>
  <Tab title="Image and video generation">
    OpenAI-compatible image adapters can use `createOpenAiCompatibleImageGenerationProvider`
    from `openclaw/plugin-sdk/image-generation`. Adapters with custom request handling can
    use `inlineOpenAiCompatibleImageUrls` before `parseOpenAiCompatibleImageResponse`.
    The URL helper bounds downloads by `maxDownloads`, `maxBytes`, and the remaining
    operation budget returned by `timeoutMs`. It trusts only `providerUrl`'s origin
    automatically, checks every redirect, and never forwards provider HTTP credentials.
    Pass only explicit operator permission as `allowPrivateNetwork`; an inferred local
    endpoint allowance must not authorize other private hosts. TLS and hostname
    overrides in `dispatcherPolicy` stay confined to the provider origin.

    Image and video capabilities use a **mode-aware** shape. Image
    providers declare required `generate` and `edit` capability blocks;
    video providers declare `generate`, `imageToVideo`, and
    `videoToVideo`. Flat aggregate fields like `maxInputImages` /
    `maxInputVideos` / `maxDurationSeconds` are not enough to advertise
    transform-mode support or disabled modes cleanly. Music generation
    follows the same `generate` / `edit` pattern.

    Bundled providers can use `normalizeVideoGenerationDuration({ durationSeconds })`
    from the private `openclaw/plugin-sdk/video-generation` subpath to round an
    optional duration and reject values outside 1–9007199254740991 seconds after
    rounding. Omission returns `undefined`; provider defaults remain provider-owned.
    Pass `supportedDurationSeconds` to the same helper to select the nearest allowed
    value, preferring the longer duration on ties. This list overrides provider/model/mode
    capabilities; omit it to use those capabilities, or pass an empty list to return
    the rounded duration without selecting an allowed value. `selectSupportedVideoDuration`
    provides selection alone for an already-normalized duration and a nonempty list.
    Keep provider-specific bounds in the provider.

    ```typescript
    api.registerImageGenerationProvider({
      id: "acme-ai",
      label: "Acme Images",
      capabilities: {
        generate: { maxCount: 4, supportsSize: true },
        edit: { enabled: false },
      },
      generateImage: async (req) => ({
        images: [
          {
            buffer: await generateAcmeImageBytes(req),
            mimeType: "image/png",
            fileName: "acme-image.png",
          },
        ],
      }),
    });

    api.registerVideoGenerationProvider({
      id: "acme-ai",
      label: "Acme Video",
      defaultTimeoutMs: 600_000,
      models: ["acme-video", "acme-image-video"],
      capabilities: {
        generate: { maxVideos: 1, maxDurationSeconds: 10, supportsResolution: true },
        imageToVideo: {
          enabled: true,
          maxVideos: 1,
          maxInputImages: 1,
          maxInputImagesByModel: { "acme/reference-to-video": 9 },
          maxDurationSeconds: 5,
        },
        videoToVideo: { enabled: false },
      },
      catalogByModel: {
        "acme-image-video": {
          modes: ["imageToVideo"],
          capabilities: {
            imageToVideo: {
              enabled: true,
              maxVideos: 1,
              maxInputImages: 1,
              resolutions: ["480P", "720P", "1080P"],
              supportsResolution: true,
            },
            videoToVideo: { enabled: false },
          },
        },
      },
      generateVideo: async (req) => ({
        videos: [
          {
            url: await generateAcmeVideoUrl(req),
            mimeType: "video/mp4",
          },
        ],
      }),
    });
    ```

    The illustrative helpers stand in for provider calls: the image helper
    returns non-empty encoded bytes, while the video helper returns a hosted
    media URL. Video providers may return non-empty encoded bytes instead,
    or both when the URL is a delivery fallback. Empty result arrays and
    empty buffers are candidate failures, except that a video asset with a
    usable URL ignores an empty buffer and continues with the URL.

    `capabilities` is required on both provider types; `edit` and the
    video transform blocks (`imageToVideo`, `videoToVideo`) always need an
    explicit `enabled` flag.

    Use `catalogByModel` when a listed model's static modes or capabilities
    differ from the provider defaults. This metadata keeps
    `video_generate action=list` and model catalogs accurate without
    invoking provider code. Request-time capability lookup and enforcement
    still belong in `resolveModelCapabilities` and `generateVideo`; reuse
    the same capability constant for both paths when possible.

    The following [private-local helpers](/plugins/sdk-subpaths#compatibility-and-private-local-helpers)
    are supported only for bundled and separately published official plugins.

    For asynchronous provider jobs, `pollProviderOperation` from
    `openclaw/plugin-sdk/provider-http` shares the bounded polling loop while
    the plugin supplies its request, completion/failure checks, and wait function.
    `pollProviderOperationJson` adds the standard HTTP JSON transport.
    Keep vendor authentication and deadline scope in the provider adapter.

    Reuse `createProviderOperationTimeoutError(deadline)` when a custom body
    reader exhausts that same deadline. It preserves the operation label and
    optional timeout in the shared error format.

    `readGeneratedVideoAsset` from `openclaw/plugin-sdk/media-generation-runtime`
    reads a response under a byte cap and derives the asset's MIME type and filename.
    Set `validateBinaryResponse` to reject non-video responses. An optional
    `overflowUrl` provides delivery only when the body exceeds that cap; malformed
    media and transport errors still fail. The caller owns response cleanup.
    `downloadGeneratedVideoAsset` also owns fetching, deadlines, and cleanup.

  </Tab>
  <Tab title="Web fetch and search">
    ```typescript
    api.registerWebFetchProvider({
      id: "acme-ai-fetch",
      label: "Acme Fetch",
      hint: "Fetch pages through Acme's rendering backend.",
      envVars: ["ACME_FETCH_API_KEY"],
      placeholder: "acme-...",
      signupUrl: "https://acme.example.com/fetch",
      credentialPath: "plugins.entries.acme.config.webFetch.apiKey",
      getCredentialValue: (fetchConfig) => fetchConfig?.acme?.apiKey,
      setCredentialValue: (fetchConfigTarget, value) => {
        const acme = (fetchConfigTarget.acme ??= {});
        acme.apiKey = value;
      },
      createTool: () => ({
        description: "Fetch a page through Acme Fetch.",
        parameters: {},
        execute: async (args) => ({ content: [] }),
      }),
    });

    api.registerWebSearchProvider({
      id: "acme-ai-search",
      label: "Acme Search",
      hint: "Search the web through Acme's search backend.",
      envVars: ["ACME_SEARCH_API_KEY"],
      placeholder: "acme-...",
      signupUrl: "https://acme.example.com/search",
      credentialPath: "plugins.entries.acme.config.webSearch.apiKey",
      getCredentialValue: (searchConfig) => searchConfig?.acme?.apiKey,
      setCredentialValue: (searchConfigTarget, value) => {
        const acme = (searchConfigTarget.acme ??= {});
        acme.apiKey = value;
      },
      createTool: () => ({
        description: "Search the web through Acme Search.",
        parameters: {},
        execute: async (args) => ({ content: [] }),
      }),
    });
    ```

    Both provider types share the same credential-wiring shape:
    `hint`, `envVars`, `placeholder`, `signupUrl`, `credentialPath`,
    `getCredentialValue`, `setCredentialValue`, and `createTool` are all
    required.

    Search tools limited to ten results can spread
    `WEB_SEARCH_QUERY_COUNT_PROPERTIES` from
    `openclaw/plugin-sdk/provider-web-search-contract` (or its config-only
    companion) into their schema's `properties`. Providers retain their own
    required fields, additional-property policy, and optional filters.

    Search providers can declare `configPath` as a path relative to their own
    plugin configuration for the Search settings page. It defaults to
    `["webSearch"]`; use `null` when the provider has no inline settings.
    Providers sharing a plugin can expose different settings without showing
    fields that only apply to a sibling provider. Credentials remain described
    by `credentialPath` and use the existing masked credential editor.

    Search providers using `openclaw/plugin-sdk/provider-web-search` should
    resolve `resolveSearchCacheTtlMs(searchConfig)` once per execution and
    pass that value to both `readCachedSearchPayload(cacheKey, ttlMs)` and
    `writeCachedSearchPayload(cacheKey, payload, ttlMs)`. A zero TTL bypasses
    reads and writes; a positive TTL bounds entry age without extending its
    original expiry. Reads return a payload marked `cached: true`, or
    `undefined` on a miss. The reader's `ttlMs` argument is optional:
    existing one-argument calls continue to use the stored expiry alone.

    Both tool definitions accept `execute(args, context?)`, where the optional
    context carries `signal?: AbortSignal`. Forward that signal to network
    requests and check cancellation after asynchronous work. Existing
    one-argument implementations remain valid; OpenClaw rejects late fetch
    results after cancellation before publishing them to its fetch cache.

  </Tab>
</Tabs>
