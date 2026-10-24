# Control UI wire benchmark

Measure the production Control UI against an isolated, real Gateway with two
synthetic conversations. The fixture has 120 messages per conversation and
eight deterministic input-replay fingerprints per assistant message. It never
sends a model request or reads the operator's Gateway state or credentials.

Build the UI once, keep the bundle immutable, and prepare a task-owned baseline
checkout with its dependencies installed. Detach both comparison checkouts at
their intended commits: a named development branch renders a badge and loads an
extra font, which would contaminate the comparison. Compare Gateway source changes with
the same UI bundle:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs scripts/bench-control-ui-wire.ts \
  --bundle-dir /absolute/immutable/control-ui \
  --compare-source-dir /absolute/baseline-checkout \
  --profile remote --pairs 10 --output /absolute/fresh-proof-directory
```

The current checkout is `candidate`; the comparison checkout is `base`. Pairs
alternate AB/BA. Run `--profile local` separately. An A/A control uses the same
checkout for both sides. Without `--compare-source-dir`, `--pairs` repeats the
fixture in one Gateway process. Use a fresh output directory for each command.

The runner copies its instrumentation into the task-owned comparison checkout.
It temporarily points each checkout's `dist/control-ui` at the supplied bundle
and restores the original after the worker exits. Do not use a checkout whose
build or Gateway another process owns. This exercises the normal bundled-asset
cache and precompression policy; configuring a custom UI root would measure a
different policy.

Each sample captures cold chat navigation, an asset-cached chat reload, New
Session navigation, and the first switch to the second conversation. Readiness
is the first animation frame with a visible transcript and an enabled composer,
or the enabled New Session input. Screenshots are taken outside timed intervals.

The report retains HTTP resource types, encoded transfer sizes, cache status,
response headers, and timings. WebSocket entries retain only frame identity,
opcode, compression status, raw/decoded sizes, and timings. Message bodies and
authentication headers are not included. A transparent TCP proxy counts RFC6455
headers and compressed payloads; decoded browser events confirm delivery. The
remote profile shares a 10 Mbps link in each direction and adds 50 ms one-way
delay to HTTP and WebSocket data. Both profiles use the same pre-paired synthetic
device without a shared secret. The remote profile adds trusted-proxy address
attribution so the Gateway negotiates its normal remote compression policy;
the local profile uses direct-local transport.

Interpret these as synthetic transport and rendering measurements. The proxy
does not simulate TLS, TCP handshake latency, packet loss, or Internet routing.
Decode/hash instrumentation has overhead. Native renderer thread CPU counters
exclude time descheduled by the host. Every action uses a fresh inspector session
so counters cannot accumulate across navigations or earlier actions. WebSocket critical-path attribution uses
browser timestamps so delayed automation callbacks cannot move the response
that caused a paint past that paint. Automation-to-assertion time is not INP.
The bounded post-readiness capture also retains secondary traffic, distinguished
from frames delivered before readiness. HTTP transfer sizes include response
headers but exclude request headers; failed/preload-cancelled fetches are retained
separately. Inspect and crop screenshots before sharing: the shell can show
host-derived names even with a synthetic profile and avatar.

For a performance claim, report ten interleaved pairs with median, p95, spread,
and host load. The target is 25% lower remote warm transcript/composer medians,
with localhost median regression at most 5% and no worse p95. On a noisy host,
collect an A/A control and use twenty pairs with renderer CPU and structural
counters. A smaller, clean wire-byte reduction remains useful when it misses
the readiness target; state that gap explicitly.
