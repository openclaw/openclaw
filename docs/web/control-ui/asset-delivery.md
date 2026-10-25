---
summary: "Control UI asset delivery, compression measurements, and HTTP multiplexing boundaries"
read_when:
  - Measuring remote Control UI cold loads
  - Evaluating compression or HTTP multiplexing changes
title: "Control UI asset delivery"
---

The Gateway serves the built Control UI from `dist/control-ui`. Its direct HTTP
and HTTPS listeners use HTTP/1.1. An HTTPS reverse proxy can provide HTTP/2 or
HTTP/3 to browsers while retaining the Gateway's existing HTTP/1.1 upstream.
Transport changes must preserve the Gateway's authentication, origin checks,
security headers, cache policy, and WebSocket behavior.

## Current delivery owners

The [UI build](https://github.com/openclaw/openclaw/blob/main/ui/vite.config.ts)
produces Brotli quality 10 and libdeflate gzip level 11 sidecars for eligible
assets. The
[static response owner](https://github.com/openclaw/openclaw/blob/main/src/gateway/control-ui-static.ts)
selects a representation using `Accept-Encoding`, emits `Vary: Accept-Encoding`,
and serves versioned assets with immutable caching. HTML remains a separate
representation because the Gateway inserts request-specific document data.
On a bounded representation-cache miss, it uses Brotli quality 4 or gzip level 6;
static assets are never recompressed per request.

| Resource                                                         | Cache policy                          |
| ---------------------------------------------------------------- | ------------------------------------- |
| HTML with embedded bootstrap data                                | `private, no-store`                   |
| Session-entry and standalone shared-session documents            | `no-store`                            |
| Ordinary SPA HTML                                                | `no-cache`                            |
| Bundled hashed assets and matching build-versioned public assets | `public, max-age=31536000, immutable` |
| Unversioned public assets, custom-root assets, and `sw.js`       | `no-cache`                            |

The service worker script stays revalidated even when its URL includes a build
query. Content negotiation emits `Vary: Accept-Encoding` and the selected
`Content-Encoding`; identity responses omit `Content-Encoding`.

The build emits route-specific preload inventories. The
[route preload owner](https://github.com/openclaw/openclaw/blob/main/src/gateway/control-ui-route-preloads.ts)
activates only the requested route's inventory. Keep those lazy boundaries when
changing delivery: preloading every route trades one navigation's latency for
unnecessary downloads on every other navigation.

## Compression measurement

Run the committed benchmark against a completed production build:

```bash
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  ui/scripts/bench-asset-compression.mts \
  --bundle-dir dist/control-ui --surface chat --rounds 5 \
  --http-requests 300 --output .artifacts/asset-compression.json
```

`--surface` accepts `startup`, `chat`, `new`, or `all`. The route surfaces use the
same build-emitted inventory as the startup performance checker. `all` selects
assets with build-produced compression sidecars. The report records source
hashes, exact bytes per asset, rotated sample order, wall time, user CPU, system
CPU, and host load.

The codec comparison uses the same loaded buffers for Brotli qualities 10 and
11, the build's libdeflate gzip level 11, zlib gzip level 6, and Brotli quality 4.
It measures compression work, excluding disk writes and other build phases.
These are compression levels from different libraries; gzip level 11 is not a
zlib setting.

For a browser experiment, add `--brotli11-output <new-directory>`. The benchmark
copies the input bundle and replaces only existing Brotli sidecars belonging to
the selected surface, including its shared assets. Files outside that inventory,
small-file eligibility, gzip, identity, HTML, and build identity stay unchanged.
This is an experimental bundle, not a
change to the production build configuration.

The optional HTTP pass uses the production Control UI handler in a separate
process and one persistent client connection. It warms each representation,
then makes exactly the requested number of sequential requests per sample.
Reported CPU belongs to the server process, not the load-generating client. This
isolates steady serving work; it does not prove full Gateway admission/auth,
browser navigation, remote RTT, or dynamic compression during serving.

A same-host measurement on October 25, 2026 used 23 chat JS/CSS assets from
commit `c9db73543a42`. Five rotated codec rounds produced:

| Representation              | Bytes under current sidecar eligibility | Median compression CPU |
| --------------------------- | --------------------------------------: | ---------------------: |
| Identity                    |                               4,794,586 |                      — |
| Brotli 10, current          |                               1,182,489 |               2,333 ms |
| Brotli 11, candidate        |                               1,160,252 |               5,501 ms |
| libdeflate gzip 11, current |                               1,363,577 |                 594 ms |
| zlib gzip 6                 |                               1,418,289 |                  97 ms |
| Brotli 4                    |                               1,408,438 |                  53 ms |

Brotli 11 saved 1.88% for 2.36 times the codec CPU. A separate 20-pair browser
comparison at 100 ms RTT improved median transcript readiness only 1.37%
(1,518 to 1,498 ms), so the build retains Brotli 10.

For 300 warm requests per sample, the isolated static server consumed a median
31.4 ms CPU with Brotli, 40.7 ms with gzip, and 61.1 ms with identity. Compressed
runs included 248 encoded responses and 52 intentional identity responses under
the existing small-file eligibility rule. Those are serving costs, separate
from the build-time codec work above.

## Route delivery hints

After selecting the route inventory and rewriting its mount paths, the Gateway
adds final `Link` response headers for critical modules and styles. Modules use
`rel=modulepreload`; styles use `rel=preload; as=style`. Optional interaction
chunks marked `fetchpriority="low"` stay excluded. Existing document hints remain
so clients without response-header support discover the same resources.

The measured `103 Early Hints` prototype duplicated all 17 hinted asset requests
through the synthetic TLS/HTTP2 proxy, including a normal-cache probe. It was
removed. Final headers produced no duplicates in the cold default-theme profile.
A separate ordinary-script-preload prototype increased browser task CPU;
modulepreload preserves the module fetch and compilation semantics.

## Service-worker navigation

Navigation preload remains disabled. A prototype enabled it for ordinary
registrations and disabled it for session-entry registrations, but the real
browser native-auth bypass issued two document requests instead of one. The
prototype was removed in full. Existing stopped-worker startup-to-fetch overhead
was about 3 ms in the 100 ms RTT profile, too small to justify that behavior risk.
The benchmark checks both ordinary and native-auth document request counts.
In 20 base/control/head samples of the final change, each had one document
request and one native-auth setup request. Selected-font completion improved
from 3,064 to 1,121 ms; transcript median changed from 1,368 to 1,399 ms.
Background precaching continues during this measurement, so its varying request
totals are not evidence of reduced work.

## HTTP multiplexing

For an existing proxy deployment, measure the browser-facing protocol before
changing the Gateway. Record `PerformanceResourceTiming.nextHopProtocol` or the
browser network protocol column, connection IDs, request queueing, and the
reload-to-transcript interval. A TLS URL alone does not establish HTTP/2.

[Managed Tailscale Serve](/gateway/tailscale) keeps a dedicated loopback backend
and owns its ingress provenance. Upstream Tailscale's
[HTTPS Serve ALPN list](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/cert.go)
advertises `h2` and `http/1.1`; verify the installed version and actual negotiated
protocol. Externally managed Serve and ordinary reverse proxies use the separate
trusted-proxy attribution contract. Do not switch authentication modes, relax
trusted proxy addresses, or expose a public Funnel route just to test throughput.

The documented [reverse proxy setups](/gateway/trusted-proxy-auth#proxy-setup-examples)
can terminate browser TLS while forwarding HTTP/1.1 and WebSocket upgrades to
the Gateway. Caddy supports [HTTP/2 and HTTP/3](https://caddyserver.com/docs/caddyfile/options#protocols)
on the browser side. Availability
depends on the installed proxy, its configuration, and network reachability;
HTTP/3 additionally needs a usable UDP path. Retain one TLS termination owner
and its existing HSTS policy.

### Direct HTTP/2 design boundary

Direct HTTP/2 requires more than replacing
[`createGatewayHttpServer`](https://github.com/openclaw/openclaw/blob/main/src/gateway/server-http.ts).
The
[request lifecycle](https://github.com/openclaw/openclaw/blob/main/src/infra/http-request-lifecycle.ts)
currently serializes HTTP/1 admission by socket, pauses socket input, and closes
the connection after rejected request bodies. Node's HTTP/2 compatibility socket
rejects raw `pause`, `resume`, `write`, and `end` operations. The
[shutdown owner](https://github.com/openclaw/openclaw/blob/main/src/gateway/server-close.ts)
also drains HTTP/1 connections, and the WebSocket owner uses HTTP/1 upgrades.

A direct HTTP/2 proposal should specify:

1. Stream-scoped body limits, cancellation, rejection, and response completion,
   while retaining the existing HTTP/1 ordering and rejection contract.
2. Session admission and bounded shutdown, including active streams and GOAWAY.
3. An HTTP/1 compatibility path for existing browser, native, plugin, and worker
   WebSocket upgrades; extended CONNECT is a separate capability.
4. Identical routing, authentication, trusted-proxy attribution, origin checks,
   CSP, security headers, and cache representation selection.
5. Evidence that removing remote request queueing improves the user flow enough
   to justify this additional transport ownership.

The smallest proof sends concurrent asset requests over one HTTP/2 session,
rejects an oversized request without corrupting its sibling, aborts uploads and
downloads, and shuts down with active streams. Follow that with paired local and
100 ms RTT browser measurements, including an unchanged A/A control on a loaded
host. A proxy-fronted measurement can establish the expected benefit first.

A synthetic TLS/HTTP2 frontend reduced six browser connections to one. In 20
interleaved pairs at 100 ms RTT, median transcript readiness moved from 1,517 to
1,481 ms (2.35%), while selected-font completion moved from 1,082 to 1,202 ms.
Local transcript medians were 390 and 400 ms, with an improved p95. These results
support measuring existing proxy deployments first, not a native listener
rewrite for this gain. This experiment did not validate an installed Tailscale
Serve deployment or a production WebSocket proxy.

## Fonts

The [typography owner](https://github.com/openclaw/openclaw/blob/main/ui/src/app/typography.ts)
selects self-hosted faces by theme and user override. Font stylesheets use
`font-display: swap` and upstream Latin/Latin-ext subsets. The build versions both
stylesheet and font URLs. Only selected or previewed faces load. The shared code
font's binary loads when rendered text needs it, unless it is itself selected as
the UI or chat face.

At the existing theme bootstrap, the typography owner preloads the selected UI
and chat normal Latin WOFF2 binaries. It deduplicates identical faces, preserves
mount prefixes and build-versioned URLs, and makes no font request for the
system-font override. Stylesheets still own extended glyph coverage and italics.
The default theme, distinct UI/chat faces, and system override were checked.
Preloading Latin can fetch an unused subset for text entirely outside that range;
this bounded cost is accepted instead of adding text-dependent font policy.

In 20 interleaved base/control/head cold-browser samples, the default normal font
completed 91 ms earlier remotely and 25 ms earlier locally. The final response
headers and font preloads together did not materially change transcript timing:

| Final change                             | Base median / p95 | Head median / p95 |
| ---------------------------------------- | ----------------: | ----------------: |
| Transcript, 100 ms RTT                   |  1,513 / 1,531 ms |  1,519 / 1,530 ms |
| Transcript, localhost                    |      405 / 429 ms |      407 / 428 ms |
| Default normal font complete, 100 ms RTT |          1,174 ms |          1,083 ms |
| Default normal font complete, localhost  |             76 ms |             52 ms |

The remote A/A transcript median was 1,516 ms; localhost was 398 ms. Remote
browser task CPU changed from 455 to 466 ms (2.36%), within the timing band,
with an improved p95. These measurements used cold fresh contexts, cleared but
enabled HTTP caches, the production static handler, and synthetic bootstrap/RPC
data. They do not measure full Gateway authentication or agent-model latency.
`font-display: swap` allows a usable transcript before its final font arrives;
the font improvement is not a transcript-latency claim.
