# macOS Rust sidecar experiment

This measures the real shared Swift Gateway/node owners against the same owners using the macOS Rust sidecar. The sidecar uses the shared Rust Gateway client and node command runtime; the echo handler stays in Swift. It does not measure the complete app, native OS tools, model inference, or a production Gateway. The benchmark command is `benchmark.echo`; the extra admission round trip for `system.*` commands is covered functionally, but excluded from timing.

## Reproduce

Use a clean reviewed candidate checkout, macOS with Swift 6.3+, Rust 1.93.0, and installed repository Node dependencies. The probe builder compiles the helper in release mode from that exact checkout and writes Cargo output under the fresh proof root. Never launch the app or full native test suite on an operator desktop.

```sh
# Run these commands from scripts/bench-macos-sidecar.
# <repo> is an explicit local path.
# <output> must be a fresh, absent directory directly under /tmp.
python3 build-probes.py --repo <repo> --output <output>
export RFC54_BENCH_ROOT=<output>
export OPENCLAW_BENCH_REPO=<repo>

# Validate the native isolation boundary before executing any probes.
node validate-sandbox.cjs

# Functional contracts and native TLS pinning.
node functional-smoke.cjs "$RFC54_BENCH_ROOT/bin/openclaw-mac-node-sidecar" functional
RFC54_CHECK_OVERFLOW=1 node functional-smoke.cjs "$RFC54_BENCH_ROOT/bin/openclaw-mac-node-sidecar" overflow
RFC54_CHECK_RETIREMENT=helper node functional-smoke.cjs "$RFC54_BENCH_ROOT/bin/openclaw-mac-node-sidecar" helper-retirement
RFC54_CHECK_RETIREMENT=gateway node functional-smoke.cjs "$RFC54_BENCH_ROOT/bin/openclaw-mac-node-sidecar" gateway-retirement
# Both original Swift and candidate auxiliary RPC lifetime/cancellation owners.
node probe-runner.cjs aux baseline auxiliary-baseline
node probe-runner.cjs aux "$RFC54_BENCH_ROOT/bin/openclaw-mac-node-sidecar" auxiliary-candidate
# A targeted 100-batch saturation/cancellation regression.
RFC54_CAPACITY_ONLY=1 RFC54_CAPACITY_BATCHES=100 \
  node probe-runner.cjs aux "$RFC54_BENCH_ROOT/bin/openclaw-mac-node-sidecar" capacity
# This command runs both matching and mismatched pins, with an empty manifest.
RFC54_EMPTY_MANIFEST=1 node probe-runner.cjs tls "$RFC54_BENCH_ROOT/bin/openclaw-mac-node-sidecar" tls

# Check process supervision (intentional Swift supervisor death).
RFC54_BENCH_FORCE_SUPERVISOR_EXIT=1 \
  RFC54_BENCH_EXTRA_ARGS='["<output>/bin/openclaw-mac-node-sidecar"]' \
  node run-bench.cjs "$RFC54_BENCH_ROOT/bin/candidate-swift" supervisor-death 1 1
# Missing-helper failure must return nonzero and leave no child processes.
RFC54_BENCH_EXTRA_ARGS='["<output>/bin/absent-helper"]' \
  node run-bench.cjs "$RFC54_BENCH_ROOT/bin/candidate-swift" missing-helper 1 1

# On a disposable Mac, package an opt-in ad-hoc signed app and prove fresh
# bundle execution, replacement with predecessor-shaped/malformed bundles,
# missing/incompatible helper rejection, valid/tampered signature behavior,
# and replacement recovery. This does not exercise a production updater.
OPENCLAW_PACKAGE_RUST_NODE_SIDECAR=1 OPENCLAW_SKIP_MLX_TTS=1 \
  ALLOW_ADHOC_SIGNING=1 SIGN_IDENTITY=- SKIP_TEAM_ID_CHECK=1 \
  BUILD_CONFIG=debug BUILD_ARCHS="$(uname -m)" \
  ../../scripts/package-mac-app.sh
RFC54_BENCH_ROOT=<output> \
  ./package-lifecycle.sh ../../dist/OpenClaw.app

# Run only after compiler/test activity finishes; use the same quiet machine.
python3 run-paired.py
```

Before execution, validate the included sandbox with `sandbox-probe`: it must deny operator file access, Keychain, preference, TCC, and WindowServer services. The validator supplies `BENCH_ROOT=<resolved output path>` and `BENCH_ENDPOINT=localhost:<fixture port>` through `sandbox-exec -D`. The selected listener must work and a different live loopback listener must fail with `EPERM`. The profile does not grant general loopback access, home-directory access, or TOFU/pin persistence. The runner supplies a fresh environment to every native process. TLS uses source-defined test certificates and explicit fingerprints.

The baseline is extracted from `73d99565248df43a0c972402ccc5bf034b34fe91`, the refreshed sidecar stack tip before macOS adoption. Candidate sources and the helper binary come from the selected clean checkout. Build metadata records the exact candidate head, helper build command, source hashes, and executable SHA-256 hashes.

## Measurements

Five paired repetitions alternate baseline/candidate order. Each repetition covers 256-byte and 4-KiB JSON payloads at concurrency 1 and 8. Each cell warms up with 100 operations, then measures 2,000 operations. Every result is correlated and its payload verified. There are 40,000 measured operations and 20 startup samples per variant.

Latency runs from fixture dispatch to receipt of the successful result, excluding payload generation. Summaries report the median of five per-run p50/p95/p99 and throughput values; raw individual latencies and per-run distributions remain available. Compare variance before claiming an improvement.

The fixture uses plain WebSocket with a test token. Identity signing, credential storage, TLS, and real Gateway authorization are excluded from throughput/startup measurements. The separate TLS probe verifies the native trust boundary, not TLS throughput. A 31-second auxiliary RPC verifies that native `timeoutMs: 0` remains unbounded through Rust; finite timeout and cancellation tests verify capacity is released without replacing the connection.

CPU is the sum of cumulative process CPU deltas reported by `ps`. RSS sums the Swift harness and its sidecar descendants before and after each measured phase. These are snapshots, not peaks or physical-footprint measurements, and shared pages can be counted in multiple processes. Process startup ends at the native harness's ready output; connect duration is measured inside Swift. Neither is complete GUI app startup.

The runner verifies owned descendant processes terminate after each run. Forced cleanup fails the run. Never reinterpret a failed cleanup or corrupted response as a performance sample.

## LOC accounting

Compare the adoption branch with the pinned stack tip. Separate production, tests/support, build/tooling, generated output and lockfiles. Discount pure moves. Swift Gateway/node owners retained for iOS count as zero deletions even when macOS routes through Rust. Report additions, removals and the net change; gross removal alone can conceal an increase in maintained code.
