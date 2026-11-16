# openclaw-iroh-ffi

OpenClaw-owned Swift and Kotlin bindings for the iroh primitives used by
`openclaw/tunnel/1`. This standalone Cargo workspace pins **iroh 1.4.1** and
**UniFFI 0.31.2**. It does not depend on or change the Node/N-API crate.
No application is switched to this transport by this crate alone.

Native apps own W's protected storage, enrollment, descriptor/pin verification,
node-only session selection, framing, admission wait, and reconnect/liveness policy.
This library receives the already-verified endpoint ID; it is not an authority or
Discovery client. There is no TCP proxy, key export API, default relay, pkarr, or
peer DNS lookup. Relay hostname resolution still uses system DNS.

## Build and generated bindings

Use the existing Rust **1.99.0** toolchain (minimum Rust 1.93):

```sh
cd crates/openclaw-iroh-ffi
export RUSTUP_TOOLCHAIN=1.99.0
cargo test --locked
cargo clippy --locked --all-targets --all-features -- -D warnings
scripts/generate-bindings.sh
# Generated source is checked in; binary libraries are not.
git diff --exit-code -- generated
cargo build --locked --release --lib
```

The generator is a feature-gated host executable, using the **same locked UniFFI**
as the runtime. `bindgen`/CLI dependencies are not enabled in mobile library builds.
Never edit generated Swift, Kotlin, C headers, or module maps by hand. See
[PACKAGING.md](PACKAGING.md) for Apple/Android commands and proof boundaries.

## API

Swift module: `OpenClawIroh` (C module `OpenClawIrohFFI`). Kotlin package:
`ai.openclaw.iroh`. Native library: `openclaw_iroh_ffi`.

On Android, call `OpenClawIrohAndroid.install(applicationContext)` once from
Application initialization before `bind`; without it, `bind` fails closed. See
[PACKAGING.md](PACKAGING.md).

```rust,ignore
bind(secret_key: Vec<u8>, relay_url: Option<String>, alpns: Vec<Vec<u8>>,
     ip_transports: bool, keep_alive_ms: u32) -> Result<Arc<Endpoint>, IrohError>
```

`bind` is async. Pass a 32-byte seed, the selected relay, `true` for optional QUIC
IP paths or `false` for relay-only, and **1,000 ms** keep-alive for tunnel/1.
Zero keep-alive is rejected. `None` disables relays, useful for local tests.
`alpns` lists accepted protocols; outbound-only nodes can pass an empty list.
The only relay map entry is the supplied relay, with iroh's Minimal preset.

| Handle             | Operations                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Endpoint`         | `id()`, `boundSockets()`, async `connect(endpointId, alpn, relayUrl, directAddrs, cancel)`, async `accept()`, async `watchHomeRelay()`, async `shutdown()` |
| `Connection`       | `remoteId()`, async `openBi(cancel)` / `acceptBi(cancel)`, `setMaxConcurrentBiStreams(count)`, `close(code, reason)`, async `closed()`                     |
| `BiStream`         | `send: SendStream`, `recv: RecvStream`                                                                                                                     |
| `SendStream`       | async `write(data)`, `finish()`, `reset(code)`                                                                                                             |
| `RecvStream`       | async `read(max)`, `stop(code)`                                                                                                                            |
| `HomeRelayWatcher` | async `next()`                                                                                                                                             |
| `CancelToken`      | `CancelToken()` constructor, `cancel()` (idempotent; passed to `connect`, `openBi`, `acceptBi`)                                                            |

IDs are bare lowercase hex (without `iroh:`); direct addresses are numeric socket
addresses, not hostnames. ALPN bytes are `openclaw/tunnel/1`. Stream bytes are Swift
`Data` / Kotlin `ByteArray`; u32 values are `UInt32` / `UInt`.

`closed()` returns `CloseInfo { kind, code, reason }`. `CloseKind` distinguishes
`Application`, `LocallyClosed`, `TimedOut`, `Reset`, and `Transport`.
The optional **i64** code maps to **Int64? / Long?**: every legal QUIC varint
(0 through 2^62−1) round-trips without narrowing. Outbound invalid codes fail before
any close/reset/stop effect. Match codes, never reason strings.

`read(max)` accepts 1 through 1,048,576 bytes, returns null only for EOF, and raises
`StreamReset(code)` for a peer reset. `write` waits for QUIC flow control and reports
`StreamStopped(code)` when available. Other small typed errors are
`InvalidArgument(detail)`, `EndpointClosed`, `Cancelled`, and `Transport(detail)`.
Kotlin's generated error type is `IrohException`; Swift's is `IrohError`.

A watcher yields current relay status first, then changes. Each `HomeRelayStatus`
has `url`, `connected`, `lastError`, and `authDeniedReason`; denial reason is a
relay diagnostic, not authority. `next()` returns null after shutdown, even if the
endpoint object is retained. Dropping a watcher retires its forwarding task.

### Lifetime and cancellation

Always **await `endpoint.shutdown()`**, then release handles. Kotlin's generated
zero-argument `close()` only releases a foreign handle; it is not transport shutdown.
Shutdown immediately interrupts pending accepts, connects, stream reads/writes and
watchers; it then waits for iroh's best-effort QUIC drain (normally fast; up to about
three seconds on failed paths with default transport settings). Cleanup is spawned
on the retained runtime and survives foreign cancellation or endpoint drop.

`stop`/`reset` signal before acquiring stream locks, so a silent peer cannot hold
those calls behind an indefinite read/write. Calls on one half serialize. Cancelling
a partially completed `write` does not roll bytes back: reset that half or shut down
the endpoint rather than retrying the same write. UniFFI 0.31.2 Swift does not
propagate `Task.cancel()` into Rust. For a single dial, pass a `CancelToken` to
`connect` (or `openBi`/`acceptBi`) and call `cancel()` from the task's cancellation
handler; that wait fails with `Cancelled` and the endpoint and connection stay usable. For streams, use stop/reset; for a
whole route, shut down the endpoint.

**Kotlin must not cancel a coroutine around a native call either.** UniFFI 0.31.2
lowers a result (an object handle or byte buffer) as soon as the Rust future is
ready. If the coroutine is cancelled after that but before the result is lifted, the
generated code frees the future and the lowered result leaks: a leaked `Connection`
is never closed, and keep-alive holds it open; a leaked `Endpoint` keeps running
with its key until shutdown. Run every suspend call in `withContext(NonCancellable)`
and cancel with the same explicit signals as Swift (`CancelToken`, stop/reset,
endpoint shutdown). If the caller was cancelled while the call ran, close or shut
down the returned object. Last connection-handle release
closes that connection; retain it while using its streams. Foreign task cancellation
must be paired with endpoint shutdown when retiring an entire route.

The owned native seed input is zeroized before network bind, on success and errors.
There is no secret Debug output or dependency error text from the bind boundary.
The endpoint necessarily retains its signing key until shutdown/drop. Swift/Kotlin
source buffers and UniFFI's marshalling copies are not guaranteed erased by this
library: callers should minimize and clear their own mutable copies. Protected
storage is an app responsibility, not a claim of non-exportable key material.

## Proof

Rust tests use real endpoints with relay disabled and loopback address hints:
ALPN handshake, identity, bi-stream data/FIN, positive/zero keep-alive inputs,
62-bit close-code fidelity, high stream-reset code, read bounds, stop/reset
interrupts, blocked read/accept/connect shutdown, and watcher termination. A focused
unit test verifies seed-buffer erasure before either successful or failed validation.
These are transport proofs, not enrollment, live relay denial, app UI, or mobile
lifecycle proof. The path-filtered workflow runs on draft PRs and retains the Apple
XCFramework as a short-lived CI artifact for consumer validation. It does not
publish packages, releases, or app builds.

A future shared Rust core with the N-API crate may remove duplicated transport
policy. It requires a separate migration of both adapters; no extraction is done here.
