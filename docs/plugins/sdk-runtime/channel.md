---
summary: "Channel-specific runtime helper groups for chunking, routing, pairing, media, and mentions"
read_when:
  - You are building or maintaining a channel plugin
  - You need channel media download, mention policy, or inbound kernel helpers
title: "Plugin runtime channel helpers"
sidebarTitle: "Channel helpers"
---

Channel-specific runtime helpers, available when a channel plugin is loaded. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference; [Channel plugins](/plugins/sdk-channel-plugins) is the step-by-step guide.

## Channel namespaces

<AccordionGroup>
  <Accordion title="api.runtime.channel">
    Channel-specific runtime helpers (available when a channel plugin is loaded). Grouped by concern:

    | Group | Purpose |
    | --- | --- |
    | `text` | Chunking (`chunkText`, `chunkMarkdownText`, `resolveChunkMode`), control-command detection, Markdown table conversion. |
    | `reply` | Buffered-block reply dispatch, envelope formatting, effective messages/human-delay config resolution. |
    | `routing` | `buildAgentSessionKey`, `resolveAgentRoute`. |
    | `pairing` | `buildPairingReply`, allowlist reads/removals, pairing-request upserts, and request-derived approval entries. |
    | `media` | Remote media download/save (see below). |
    | `activity` | Record/read last channel activity. |
    | `session` | Session metadata from inbound events, last-route updates. |
    | `mentions` | Mention-policy helpers (see below). |
    | `reactions` | Ack-reaction handles for in-flight processing indicators. |
    | `groups` | Group policy and require-mention resolution. |
    | `debounce` | Inbound message debouncing. |
    | `commands` | Command authorization and text-command gating. |
    | `outbound` | Load a channel's outbound adapter. |
    | `inbound` | Resolve ingress with the host-bound `ingress` helpers, build inbound event context, and run the shared inbound-event/reply kernel. |
    | `threadBindings` | Adjust idle-timeout/max-age for bound session threads. |
    | `runtimeContexts` | Register, read, and watch process-local per-channel/account/capability context. |

    `api.runtime.channel.media` is the preferred surface for channel media downloads and storage:

    ```typescript
    const saved = await api.runtime.channel.media.saveRemoteMedia({
      url,
      subdir: "inbound",
      maxBytes,
      filePathHint: fileName,
    });
    ```

    Use `saveRemoteMedia(...)` when a remote URL should become OpenClaw media. Use `saveResponseMedia(...)` when the plugin already fetched a `Response` with plugin-owned auth, redirect, or allowlist handling. Use `readRemoteMediaBuffer(...)` only when the plugin needs raw bytes for inspection, transforms, decryption, or reupload. `fetchRemoteMedia(...)` remains a deprecated compatibility alias for `readRemoteMediaBuffer(...)`, tracked as `plugin-runtime-api-compat-aliases` in the [compatibility registry](/plugins/compatibility#current-compatibility-areas) with a `removeAfter` date of 2026-10-01.

    For unsuccessful HTTP responses, media errors report the status and include a bounded body excerpt when available. A discarded error body is not reported as an empty upstream response. A successful response with no body is still rejected as empty media.

    Remote media options and `fetchWithSsrFGuard(...)` from `openclaw/plugin-sdk/ssrf-runtime` accept a synchronous `beforeRequest` callback for final-dispatch authorization checks. It runs after proxy, DNS, and dispatcher preparation and immediately before every physical request. Redirects invoke it once per hop; media retries invoke it again for every attempt and hop. If it throws, that request is not sent and the same error propagates. Promise or thenable results are rejected before transport dispatch.

    For `saveRemoteMedia(...)`, pass a synchronous `assertCurrent` callback when a read can lose permission while its body is downloading. The media owner combines it with any enclosing read scope and rechecks it through requests, streaming, and local-file publication, cleaning up unaccepted files on failure. Forward cancellation with `requestInit.signal` as well. Omitting `assertCurrent` preserves existing behavior; `beforeRequest` remains the per-request hook rather than a file-publication guard.

    Guarded fetch also accepts a synchronous `resolveDispatcherPolicy(url)` override, reevaluated for each redirect. An undefined result uses `dispatcherPolicy`, or direct routing when no default policy is supplied. Providers preserving operator-configured proxy routing can use `resolveEnvHttpProxyAgentOptions` and `matchesNoProxy` from `openclaw/plugin-sdk/fetch-runtime` to select each hop. The `trusted_explicit_proxy` mode permits HTTP, HTTPS, `socks:` and `socks5:` proxy URLs and delegates target DNS to the explicitly trusted proxy; proxy-host validation and target-host policy still apply. Direct hops keep DNS pinning. Strict mode rejects SOCKS proxies, and the separate trusted-env-proxy gate remains HTTP(S)-only.

    `api.runtime.channel.mentions` is the shared inbound mention-policy surface for bundled channel plugins that use runtime injection:

    ```typescript
    const mentionMatch = api.runtime.channel.mentions.matchesMentionWithExplicit(text, {
      mentionRegexes,
      mentionPatterns,
    });

    const decision = api.runtime.channel.mentions.resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: mentionMatch.matched,
        implicitMentionKinds: api.runtime.channel.mentions.implicitMentionKindWhen(
          "reply_to_bot",
          isReplyToBot,
        ),
      },
      policy: {
        isGroup,
        requireMention,
        allowTextCommands,
        hasControlCommand,
        commandAuthorized,
      },
    });
    ```

    Available mention helpers:

    - `buildMentionRegexes`
    - `matchesMentionPatterns`
    - `matchesMentionWithExplicit`
    - `implicitMentionKindWhen`
    - `resolveInboundMentionDecision`

    Use the normalized `{ facts, policy }` path for mention decisions.

    Several fields under `reply`, `session`, and `inbound` carry per-field `@deprecated` notes pointing at the current channel-turn kernel or channel-outbound adapters; check the inline JSDoc on the specific helper before building new code on it. They share the same `plugin-runtime-api-compat-aliases` registry record and `removeAfter` date of 2026-10-01.

  </Accordion>
</AccordionGroup>

## Awaited conversation binding mutations

Import routing and service helpers from
`openclaw/plugin-sdk/conversation-binding-runtime`.

Await `getSessionBindingService().touchAsync(bindingId, at, scope)` when recording
binding activity. Adapters implement `touchAsync` to return a Promise that settles
their accepted mutation. Async dispatch prefers that method and propagates its
failure; it does not invoke the legacy `touch` alongside it. Before invoking
each selected adapter, dispatch checks that its registration is still current.
It skips retired registrations without adopting their replacements.

Use `resolveRuntimeConversationBindingRouteAsync` for routing that records activity.
It waits for the selected mutation and then rechecks the current binding before
returning its route. Prepare ownership facts with
`await service.inspectByConversationAsync(conversation)`, then pass those facts to
`inspectRuntimeConversationBindingRoute({ route, inspection })`. This synchronous
projection performs no storage access. Inspection preserves the distinction
between a missing binding and an unavailable adapter without creating a missing
store or pruning expired rows.

Adapters provide `inspectByConversationAsync` for read-only inspection and
`resolveByConversationAsync` for ordinary lookup. The host service exposes both
methods. Generic bindings and bundled account-scoped adapters run inspection in
the shared-state read worker; lookup repairs and activity writes use the existing
writer broker. Their transaction predicates, expiry rules, and account ownership
remain unchanged. Host eligibility is prepared before IPC, and current adapter
and registry ownership are rechecked after reads and at write admission.

Lifecycle setters have explicit Promise-returning counterparts:
`channel.threadBindings.setIdleTimeoutBySessionKeyAsync` and
`setMaxAgeBySessionKeyAsync`. Channel adapters expose the same suffixed methods.
Callers await their results before reporting the affected bindings.

The existing synchronous lookup, touch, route resolver, and lifecycle setter contracts
remain deprecated through the next Plugin SDK major. The resolver's staged
migration is recorded here and in the compatibility registry; its broad barrel
is already deprecated, while its per-function IDE annotation is deferred until
the caller migration is complete. Synchronous entry points call only synchronous
implementations; they never start an async mutation whose result would be lost.
An adapter exposing both variants keeps them under the same state owner.

During the staged migration, async dispatch falls back to an adapter's existing
synchronous method when its async counterpart is absent. This preserves external
plugin compatibility; that fallback does not make a legacy adapter nonblocking.
Generic and account-scoped bind/unbind operations, list operations, and separate
lifecycle setters still require their own persistence migrations. Other bundled
stores also retain their existing behavior until their respective cutovers.
Worker-backed route reads and activity updates do not imply a fully migrated
binding service or stronger durability for those remaining operations.
