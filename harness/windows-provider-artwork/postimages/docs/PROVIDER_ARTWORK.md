# AI setup provider artwork

`GatewayAiSetupPresentation` resolves provider artwork independently of credential,
discovery and setup workflows. `AiSetupPage` forwards `brandId`, provider/candidate
ID, `icon`, provider `kind` and `actionLabel`. `ProviderArtwork` owns the WinUI
image and `ProviderArtworkSession` owns the AI page's download/cache lifetime.
The manual-provider picker uses the same row artwork as the action cards. The
provider dialog retains the explicitly invoked row's descriptor alongside its
text title through notes, inputs and confirmation. It borrows the page session;
dismissal detaches its control without disposing the session used by the chooser.
The existing page close path cancels all artwork before connection cleanup.

## Pinned platform comparison

The reference is `openclaw/openclaw` commit
`0fd603a6fece58d60c010e565df9e26c6601db8b`, specifically
`apps/macos/Sources/OpenClaw/OnboardingProviderArtwork.swift` and
`OnboardingAISetupView.swift`.

- The nine bundled SVGs and their notices remain unchanged. The closed alias map
  resolves Claude/Anthropic, Codex/OpenAI/ChatGPT, Gemini/Google, Ollama, LM Studio,
  Pi, OpenCode, Kimi/Moonshot and Grok/xAI, including the leading-token fallback
  for method-suffixed IDs. Explicit `brandId` wins over candidate kind/provider ID.
- A bundled logo wins over a remote URL. Unknown brands may load a Gateway-supplied
  public HTTPS logo. Any failure leaves a native Fluent icon, never a broken image.
- Artwork is decorative. Provider names, descriptions and selection semantics
  remain accessible independently of the image.
- Provider metadata action labels take precedence. Windows defaults are **Pair**,
  **Set up…**, **Configure…**, and **Connect**. The pinned Mac auth-row default is **Sign in**, and its prepare-row
  fallback is **Connect / Set up**. These are explicit copy differences, not
  assertions of exact text parity.
- Bundled sources use WinUI's library-qualified resource URI resolution, including
  unpackaged installations. A visible Image consumes the source before awaiting
  Opened because URI decoding is demand-driven. The fallback stays visible until
  success; rebind/unload cancels loading without allowing an old completion to
  clear the replacement source.

## Remote trust boundary

These are display downloads, not authenticated Gateway calls:

| Gate | Bound |
| --- | --- |
| URI | HTTPS, port 443, at most 2,048 characters, no userinfo or fragment |
| Host | No local/single-label names or non-public IP literals |
| Connection | Resolve inside `ConnectCallback`; reject all answers if any is unsafe; connect directly to a checked IP with no second lookup |
| Address | Loopback, private, link/site-local, multicast, reserved, documentation, benchmark, transition and mapped-private addresses blocked; IPv6 limited to global unicast |
| TLS | Platform hostname/certificate validation and SNI retained |
| HTTP | No redirects, auth retries, credentials, cookies, proxy, referer, trace propagation or automatic decompression |
| Acquisition | 6-second deadline including admission; 4 concurrent, 16 admitted requests |
| Encoded data | 256 KiB, checked against both advertised length and actual streamed bytes |
| Cache | Memory only, page lifetime, 16 entries, 2 MiB total, 5-minute expiry |
| Native decode | 2 active decoders; excess work falls back; 10-second control deadline includes acquisition and decode |
| Raster | PNG/JPEG MIME and signatures; native codec and single frame checked; width/height at most 1,024, at most 1,048,576 source pixels before BGRA extraction |
| Render output | At most 24 by 24 BGRA pixels for raster, 24 by 24 rasterization for vector |

The decoder keeps its concurrency slot and stream until native work actually
finishes, even after a caller's deadline. A timeout does not falsely imply native
work was forcibly terminated. Rebind, unload and page closure cancel and fence
old completions; unload and closure immediately release displayed image references.
The page owns and disposes its finite encoded cache.
Loader disposal atomically closes admission and clears that cache, then cancels
active and queued requests. The final admitted request disposes the HTTP
transport after cancellation has unwound; disposal never removes the transport
under a request that still owns it. Already admitted work observes cancellation,
while a new load after disposal still throws `ObjectDisposedException`.

Failures use a local tooltip with a finite category: blocked, network, HTTP,
oversized, unsupported, invalid image, timeout or busy. No URL, query, image,
exception message, credentials or raw response is written to application logs or
telemetry. Framework HTTP diagnostics are not subscribed/exported by this feature.

## Remote SVG subset and remaining differences

Remote SVGs are not passed to a browser or unrestricted native parser. XML has
DTDs and external resolution disabled. A new document is reconstructed from only
`svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, and `polygon`.
Attributes are limited to bounded numbers, viewBox, path/point data, plain
fill/stroke colors, opacity and enumerated stroke/fill rules.

Limits: 256 reader nodes, depth 16, 16 attributes per element, 32,768 total path
characters, 2,048 explicit commands and 4,096 numeric tokens per path. Numeric
values must be finite and no greater than 10,000 in magnitude; viewBox width and
height must be positive and no greater than 1,024. Compact adjacent signed path
numbers that do not tokenize into this strict subset are rejected.

No scripts, event attributes, styles/CSS, fonts, external or internal references,
`use`, images, nested SVGs, foreign objects, filters, gradients, transforms or
animation are accepted. XML stylesheet instructions and unknown attributes fail
closed. Accepted vectors are monochrome in the existing dark logo well; raster
colors are preserved. Bundled SVGs remain native `SvgImageSource` resources.

This is deliberately narrower than Mac's unrestricted `NSImage` decoding and
unbounded shared URL session. Other raster formats, arbitrary SVG documents,
nonstandard HTTPS ports, redirects and non-public hosts use the fallback.
This implementation does **not** claim complete remote-format parity.

## Validation

`ProviderArtworkTests` uses synthetic HTTP handlers and injected DNS/socket
functions only. It covers aliases and precedence, action labels, URI/IP policy,
mixed DNS answers, actual-address pinning, credential/redirect rejection, MIME,
stream size, cancellation/deadline, request admission/concurrency, cache bounds,
SVG rejection and stale generations. `ProviderArtworkSourceContractTests` covers
metadata forwarding, WinUI lifetime wiring and the native decoder's gates.

Native rendering, malformed native codec behavior, accessibility, high contrast,
and real network/TLS behavior still require an authorized isolated UI proof pass.
Unit/source tests are not runtime or screenshot proof.
