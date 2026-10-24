---
summary: "Build the Control UI, run the dev server, and point it at a remote Gateway"
read_when:
  - Building or serving the Control UI yourself
  - Running the Vite dev server against a remote Gateway
title: "Build and develop"
sidebarTitle: "Build and develop"
---

Contributor notes for building the Control UI and running it against a Gateway you choose.

Every command on this page runs from a checkout of the `openclaw/openclaw`
repository with `pnpm install` already done. A packaged CLI install has no
`pnpm` scripts.

## Build and develop the UI

The Gateway serves static files from `dist/control-ui`:

```bash
pnpm ui:build
```

Full package builds include matching bundled native plugin assets, including
Workboard, in the UI distribution. These assets can load from the UI origin when
the Gateway uses another origin or authenticated HTTP. The running plugin must
match the packaged version and browser build; custom plugins and source overrides
retain the Gateway asset route. A standalone UI build without packaged plugin
artifacts also retains that route.

The build's performance report keeps the initial-entry JavaScript budget separate
from the complete chat and new-session boot totals. Those route totals include
the entry assets and the route's measured immediate dynamic imports, counting
each asset once even when both preload lists reference it. Moving an existing
boot import into the first request wave therefore remains visible in the byte
accounting. Initial-entry JavaScript uses the committed gzip baseline plus the
checker's growth and build-variance allowances; the baseline itself may not exceed
325,000 B. Startup CSS is limited to one request. Each complete chat and New Session
boot is limited to three CSS requests: the initial sheet, shared route styles,
and the route's own sheet. Optional component styles stay with their lazy modules.
CSS consolidation is bounded by the largest-sheet cap and fixed total CSS ceilings
of 303,372 B gzip and 1,595,521 B raw. If the merge base already exceeds a ceiling,
only 64 B of build variance is allowed. Startup CSS growth must stay below 1.5 KiB
against the merge base; splitting files is not a byte reduction.
The boot manifest retains reachable CSS imports even when extraction removes their
JavaScript source-map entries. Complete boot JavaScript is capped
at 1,500,000 B gzip for chat and 1,035,000 B gzip for New Session, including the
initial-entry assets.
JSON5 remains in its own lazy chunk so snapshot validation cannot pull the raw
configuration parser into chat boot. Syntax highlighting and its language grammars
load on the first code block; code stays escaped and copyable while they load or
if the optional chunk fails. MarkdownIt owns rendered HTML, while the separate
CommonMark source parser preserves exact code and reasoning offsets. Every HTML
render still passes through its sanitizer. `--base-dist` on
`scripts/check-control-ui-performance.mts` compares route bytes and requests when
both builds contain route preload templates. Older builds report that comparison
as unavailable, so use a cold-load network capture to compare their complete boot
cost.

JavaScript is limited to 9 initial-entry requests, 27 complete chat boot requests,
and 22 complete New Session boot requests. These caps catch facade regressions
caused by top-level await disabling chunk optimization. `pnpm ui:check-performance` enforces the route byte and request
limits locally and in CI; `pnpm ui:build` reports them without rejecting the build.
Worker scripts and other URL assets remain available in the offline cache without
being modulepreloaded into the document.

Selecting a language loads its startup catalog and translations for English namespaces
that are already registered. Other page-only namespaces and configuration hints load
when first used, with English fallback while the request is pending. Route loading
waits for the selected language's newly registered namespaces before mounting the page,
so editable defaults start in that language. The
build derives this split from the English startup catalog and canonical translation
memory for every language. The combined base and configuration-hint catalog size is
capped at 307,200 B gzip per language; `pnpm ui:check-performance` enforces this cap
both locally and in CI and reports every language's remaining headroom.

MCP app new-conversation handling loads when the app requests a conversation.
New Session includes its completion handler in the route bundle, so submission
does not pause for another chunk before sending the creation request.

Session creation and message sends retain a dispatched result after Stop or view
cancellation, so the owning flow can reconcile accepted work before settling or
cleaning up its placement. Cancellation still stops unsent work and requests
refused before dispatch.

After a Gateway update, already-open tabs reload the current build when they encounter a missing old asset. Reloading is automatic when no unsaved-work guard blocks it; otherwise, save or discard the protected work and use the **Reload** banner. The Gateway and service worker keep only the current build's assets.

Bundled public assets (themes, fonts, icons, and artwork) use `?v=<build-id>` URLs with a one-year immutable HTTP cache. The ID includes a digest of the public files, so rebuilding changed files at the same commit also changes their URLs. The Gateway snapshots this identity at startup; restart it after rebuilding an in-place installation. Unversioned requests, stale IDs, documents, `sw.js`, and custom `gateway.controlUi.root` installs keep `Cache-Control: no-cache`. The service worker caches matching current-build public URLs for offline reuse.

The build precompresses bundled assets of at least 4 KiB into Brotli and gzip
sidecars, keeping each sidecar only when it is smaller than the original. CSS
and the startup assets measured by the performance gate are compressed at any
size. This limits file counts in installed packages while preserving startup
transfer costs. Missing sidecars fall back to the
original asset without on-the-fly compression; performance budgets count those
identity bytes. Gzip uses
the pinned, build-only libdeflate WebAssembly encoder at level 11 rather than a
host-native library. Brotli remains at quality 10. Both encode the final emitted
asset bytes; no decompressor is added to the browser bundle. Compare gzip size
and encoder CPU/wall time on an existing build with
`node ui/scripts/bench-gzip.mjs dist/control-ui 5`. This serial, interleaved
comparison excludes file I/O and Brotli; it is not a full-build timing benchmark.

The Gateway reads and shares only the negotiated representation across browsers; a Brotli
request does not read the original and gzip bodies. Cold file admission and reads
run in a worker so simultaneous page loads do not block chat delivery. Custom
roots continue to read current files on each request. Rewritten index documents
use a separate bounded compression cache.

Non-index static assets use `Last-Modified` for conditional `GET` and `HEAD` requests. `If-None-Match` takes precedence over `If-Modified-Since`: `*` matches an existing asset, while other values receive the normal `200` response because static assets do not emit ETags. Date-only revalidation still returns `304` for unchanged assets. If no available content encoding is acceptable, the Gateway returns `406` before evaluating either condition.

All three HTTP-date formats are interpreted as UTC. Invalid or repeated `If-Modified-Since` fields are ignored, so they cannot suppress the current asset bytes. A leap-second validator remains earlier than the following second.

Static asset URLs support percent-encoded filenames. Contained symlinks retain the requested asset's MIME type, and a symlinked `index.html` receives the same base-path and document preparation as other entry routes.

Optional absolute base (fixed asset URLs):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Local development (separate dev server):

```bash
pnpm ui:dev
```

Then point the UI at your Gateway WS URL (e.g. `ws://127.0.0.1:18789`).

To use the real Gateway's capabilities, media, and native plugin UI while
developing, select its URL when starting Vite:

```bash
OPENCLAW_UI_DEV_GATEWAY_URL=http://127.0.0.1:18789 pnpm ui:dev --host 127.0.0.1 --port 5173
```

Configured development binds to loopback by default. Open `http://127.0.0.1:5173` and use the Gateway's normal authentication and
device pairing. The target accepts `http://`, `https://`, `ws://`, or `wss://`,
including a configured Gateway base path. Keep credentials out of this setting.
Add the exact browser origin to `gateway.controlUi.allowedOrigins` when needed;
the development proxy preserves the browser's Origin and does not provide
authentication credentials.

Vite serves the UI and its hot reload connection, and proxies Gateway requests.
If the Gateway disconnects, the proxy retires that connection so the UI can reconnect without restarting Vite.
The UI keeps credentials and saved settings scoped to the actual Gateway. An
owner pairing handoff can be delivered on the dev page while retaining its
original Gateway destination and fragment. To use another Gateway, restart
Vite with the new target; an already-open page cannot forward requests through
the replacement target. Reload the page after restarting Vite.

UI edits use Vite's normal hot reload or page reload. Start the Gateway's source
watch separately when developing its implementation. Stopping Vite stops its
proxy, without stopping the Gateway or deleting either application's state.
Without `OPENCLAW_UI_DEV_GATEWAY_URL`, `pnpm ui:dev` retains its existing
standalone connection behavior. This setting does not affect `pnpm ui:build`.

### Measure cold HTTP delivery

The cold-load benchmark normally serves the production build through Vite
preview. To measure the Gateway's document rewriting, compression and asset
reader, start an isolated loopback Gateway, then run:

```bash
node --import ./scripts/tsx.mjs scripts/bench-control-ui-cold-load.ts \
  --bundle-dir dist/control-ui --gateway-url http://127.0.0.1:19450 \
  --face chat --first-load --runs 1 --cold-http-cache --untraced \
  --network-latency-ms 35 --download-kbps 10000 --cpu-throttle 4
```

The report includes document TTFB, the asset waterfall and transfer sizes, boot
RPC request/response timings, and first visible transcript and enabled-composer
timings. Visibility is sampled at animation frames; it is not a compositor-paint timestamp. Composer focus is
recorded only if it occurs. HTTP uses the real Gateway; bootstrap, WebSocket
replies and fixture media remain synthetic. The benchmark fetches the public
`/chat` document, then selects the synthetic session before app imports. Use
`--boot-route new` to fetch `/new` and measure its composer instead; this preserves
the Gateway's route-specific preload selection. Real session-entry authorization
is outside this measurement. Each run also saves `run-N.requests.json`, including
browser request initiators, to distinguish parser preloads from chained imports.
Use `--viewport mobile` for a 390×844 viewport; the default desktop viewport is
1719×1179. Combine it with `--color-scheme light` or `--color-scheme dark` for
responsive theme comparisons. The report records the viewport name and dimensions.
Mobile measures the actual responsive boot with the navigation drawer closed;
it does not require desktop sidebar rows to render. Sidebar-specific options
can still deliver owner events without presenting the closed drawer.
Font loading completions are recorded separately from composer and transcript
readiness. The fixture mirrors
the Gateway's terminal policy to preserve the document's CSP contract.
`--first-load` skips the benchmark's normal warm-up navigation. Restart the
isolated Gateway before each sample to reset its asset and HTML compression
caches, and interleave at
least ten baseline and candidate samples on a busy host. Use the same bundle
identity and fixture time for both sides. Run `--cpu-profile` separately for source-mapped CPU
diagnostics; profiled timings are not comparable with untraced samples.

For a standalone preview with synthetic data, use:

```bash
pnpm dev:ui:mock -- --port 19321
```

Open the printed URL in a fresh Chromium profile or isolated browser context,
without existing service workers or operator credentials. Chat, presence, and
profile data are synthetic. Add `--fixture attachments` for media examples; the
printed board fixture URL is also available.

The mock preview selects its own origin for Gateway resources, including
avatars, before application startup. It supplies synthetic WebSocket responses
and confines native resource requests to the serving origin and local data/blob
fixtures, including frames, while preserving same-origin Vite HMR and terminal
WebAssembly. Unimplemented HTTP API routes return a local JSON 404; external
fetches are rejected with a standalone-mock diagnostic. New workers, Talk WebRTC,
popups, and external link/navigation actions are disabled in the mock app.
External iframe URL assignments are rejected before Chromium can speculatively
connect. Add a local fixture when a demo needs another response. Each invocation
owns a separate Vite cache and removes it on graceful shutdown, so concurrent
previews and attachment fixtures do not invalidate one another.

This is a trusted-fixture development boundary, not a sandbox for hostile HTML,
browser extensions, or an already-controlling service worker. Browser-level
navigation outside the app is outside its control. Production connection settings
and `pnpm ui:dev` behavior are unchanged; use that command when you intentionally
need a real Gateway or external integration.

## Chat input ownership

`ChatOutboxGatewayOwner` owns queued-input admission, updates, removal, and the
matching pane projections. Single-row changes and reordering share one durable
compare-and-set operation; queue callers do not publish separate storage and
display updates. Command completion uses the composer recovery owner to retain
or release draft attachments. Delivery waits for the full settings-update chain,
then continues admission synchronously so another picker update cannot enter
between settlement and transport.

## Chat render scheduling

Streaming deltas and session-roster notifications must not trigger unrelated
renders. The shell processes session deletion and document-title updates directly,
without rendering for roster publications. The pane runtime owns session
observations and synchronizes their state immediately. The chat state owner
coalesces eligible background invalidations in an animation frame. Solid
projections and the pane render lifecycle publish presentation and run
post-commit work after DOM bindings. Hidden documents bypass frame scheduling;
retained hidden panes park presentation until shown. Retiring the render-lifecycle
scope cancels queued background work.

The `chat-stream-runtime-budgets.e2e.test.ts` suite protects streaming with
structural update counts; chat-page unit tests cover intervening roster publications.

Session descriptors share connection-scoped reads. Full row changes invalidate
them; unchanged ancestor references reuse the settled read. Swarm progress follows
the collector's parent summary, not a child provider's terminal status. Child rows
already update their own presentation, while changed collector summaries and
membership still refresh the parent details.

Shell callbacks retain their identity across renders so a background session update
does not redraw navigation twice. The outbox subscription still invalidates draft
and attention badges when their underlying facts change. Session-link decoration
preserves unchanged attributes instead of rewriting them on each roster update.

Transcript enhancement inspects inserted or changed Markdown blocks; settled code
blocks and tables do not need another scan when neighboring prose streams. Resize
observers own geometry changes. The command palette likewise retains its measured
input layout while navigating results, and remeasures edits, width changes, and
reconnected fields. Status clocks pause in hidden tabs and render only when their
displayed value or properties change.

The first connected, presented transcript commit renders two neighboring rows beyond each
viewport edge. The next animation frame restores the six-row scrolling buffer;
pending navigation, focus, or anchor reconciliation uses that full buffer immediately,
including neighboring controls such as folded-work headers. Focused and anchored
rows remain retained independently. Link-preview discovery
waits for browser idle time, then follows transcript mutations instead of rescanning
unchanged content on every pane update. Hiding or retiring the pane cancels pending
discovery.

Streaming Markdown retains normalized input, split progress, and rendered prefixes
in one bounded cache. Completed independent blocks render once; replacements,
locale or display-option changes, and document-wide Markdown dependencies invalidate
that reuse. Lists, reference definitions, containers, raw HTML, and colliding file labels
retain their whole-block or whole-prefix semantics and the existing parse limits.

Composer edits publish transcript resize notifications only when the viewport
height or corrected scroll offset changes. Draft growth, shrinkage, and end
anchoring still synchronize immediately. The position rail observes column width
and conversation-region height instead of measuring the gutter on every streamed
render; virtualizer and sidebar geometry changes retain their explicit sync path.
Rail labels are shared across mounted markers, so offscreen history does not add
translation work on each stream update.

Sidebar narration releases its session interests while hidden. Acquires and releases
share bounded exponential retry backoff with full jitter and server delay hints.
Failed releases retain their original handles, including late hidden acquisitions;
returning interests cancel queued releases and reacquire before retiring those handles.
The shared connection coordinator renews observers after uncertain unsubscribe timeouts
and preserves other viewers' leases and approval delivery. DOM detachment pauses timers
without dropping retained handles; connection closure retires them and cancels retries.

## Talk live smoke test

Maintainers can exercise the browser Talk paths end to end from the repository
root. Replace each placeholder with a real key:

```bash
OPENAI_API_KEY=<openai-key> GEMINI_API_KEY=<gemini-key> \
  node --import tsx scripts/dev/realtime-talk-live-smoke.ts
```

The run verifies the OpenAI backend WebSocket bridge, a synthesized PCM24
speech-to-response audio roundtrip, OpenAI browser WebRTC SDP exchange, Google
Live constrained-token browser setup with a JPEG frame and `describe_view`
function roundtrip, and the Gateway relay browser adapter with fake microphone
media. Pass `--openai-audio-cycles 3` for a short repeated OpenAI connect,
talkback, and close soak. The command prints provider status only and does not
log secrets.

## Debugging/testing: dev server + remote Gateway

The Control UI is static files; the WebSocket target is configurable and can differ from the HTTP origin. This is handy when you want the Vite dev server locally but the Gateway runs elsewhere.

<Steps>
  <Step title="Start the UI dev server">
    ```bash
    pnpm ui:dev
    ```
  </Step>
  <Step title="Connect the remote Gateway">
    Follow the [remote Gateway URL handoff](/web/urls#remote-gateway-handoff)
    reference for the encoded Gateway URL and optional one-time credentials.
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Origin security notes">
    - Public non-loopback Control UI deployments must set `gateway.controlUi.allowedOrigins` explicitly (full origins). Private same-origin LAN/Tailnet loads from loopback, RFC1918/link-local, `.local`, `.ts.net`, or Tailscale CGNAT hosts are accepted without enabling Host-header fallback.
    - Gateway startup may seed local origins such as `http://localhost:<port>` and `http://127.0.0.1:<port>` from the effective runtime bind and port, but remote browser origins still need explicit entries.
    - Do not use `gateway.controlUi.allowedOrigins: ["*"]` except for tightly controlled local testing; it means allow any browser origin, not "match whatever host I am using."
    - `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` enables Host-header origin fallback mode, but it is a dangerous security mode.

  </Accordion>
</AccordionGroup>

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Remote access setup details: [Remote access](/gateway/remote).
