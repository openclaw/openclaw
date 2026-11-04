# Base64 Rust/WASM validation experiment

Experimental only: this directory is not imported by OpenClaw, adds no runtime
selection, and does not ship a WASM artifact or new package dependency. Nothing
here changes filesystem authority. Do not land or promote this experiment as a
production performance fix without the missing product-flow proof.

## Why this candidate survived the source scan

The shared scanner in `packages/media-core/src/base64.ts` is used by attachment
preparation, image/media boundaries, Talk relay audio, xAI audio deltas, Google
Live audio, OpenAI Quicksilver audio, and voice-call media frames. These paths
are conditional on uploads or enabled realtime media, not every text turn.
A helper reference count is not production usage telemetry; no live traffic or
private payloads were inspected.

Important existing optimization: `prepareMediaAttachment` offloads inputs at
256 KiB **encoded characters** to the existing compute pool. Its runtime scans
once and passes the resulting facts to MIME sniffing instead of rescanning.
Thus a large-payload scanner win primarily saves upload-worker CPU/latency,
not an already-demonstrated Gateway event-loop stall. Ordinary text turns
without attachments do no work in that upload path.

PCM downmix/channel duplication was rejected as a separate port candidate.
For 20 ms frame-equivalents, 960 iterations per loop took roughly 14 microseconds
each on this host. Even eliminating both loops would save only about 1.39 ms
CPU/second per active bidirectional stream (0.139% of one core), before bridge
cost. The shared resampler does more work; that is not permission to rewrite it.
Outbound realtime conversion already runs in an audio worker. No population-wide
voice usage or end-to-end audio bottleneck is claimed.

## Acceptance rule established before measurements

- Exact `Base64Facts | undefined` parity for both dialects, including C0 whitespace,
  padding, nonzero terminal bits, invalid alphabets, Unicode and lone surrogates.
- Compare the **whole host adapter**, including string-to-memory conversion,
  Rust execution, result conversion and normalization. Pure kernel timing is
  insufficient. Include a simpler JavaScript lookup-table algorithm control.
- Seven interleaved samples after warmup; voice-sized and large inputs; report
  spread and fresh-instance first use separately.
- At least 20% lower median/observed-max latency at >=1 MiB, no material small
  input/cold regression, and no unaccepted memory/copy tradeoff. Product promotion
  additionally needs actual attachment-flow, packaging, and runtime-matrix proof.

The isolated experiment clears the helper speed/parity checks below, but **does
not clear the complete promotion gate**: it retains a second linear-memory copy
and has no Gateway/browser/Bun/native-app packaging or attachment-flow result.

## Reproduce

Tested with Node 26.12.1 and Rust 1.99.1. The Rust source has no crate dependencies.
Install the compiler's `wasm32-unknown-unknown` standard-library target beforehand;
no toolchain download or consumer install script is performed by this experiment.
From the repository root:

```sh
mkdir -p .openclaw/tmp/wasm-base64-experiment
rustc --edition=2024 --crate-type=cdylib --target wasm32-unknown-unknown \
  -C opt-level=3 -C panic=abort -C link-arg=--export=__heap_base \
  -C link-arg=--max-memory=67108864 -C strip=symbols \
  scripts/perf/wasm-base64/scan.rs \
  -o .openclaw/tmp/wasm-base64-experiment/scan.wasm
node scripts/perf/wasm-base64/measure.mjs \
  > .openclaw/tmp/wasm-base64-experiment/results.json
```

The adapter owns one private instance. It grows memory as needed, reacquires its
view after growth, uses `TextEncoder.encodeInto`, and returns ordinary JS values,
never aliases into reusable WASM memory. Non-ASCII UTF-8 is rejected, including
when encoding cannot fit in the ASCII-sized input span. The module has no host
imports; invalid spans/dialects reject and linear memory is capped at 64 MiB.
Its raw pointer ABI is experimental, not a public SDK contract.

`table-control.mjs` copies the current source and substitutes only the alphabet
decoder with a 128-entry lookup table. It does not change production source or
claim to be an independent complete implementation. It fails if the expected
source function boundary is absent. Node's experimental TypeScript stripping
API is used only for this control, never in production.

## Observed results

Source oracle: OpenClaw `54db47573b45af5d724860179674b7994c9fa80f`. The shared
scanner, attachment worker threshold, and PCM helper were unchanged in inspected
upstream `e90948d26ee3966e7da454266255a7ed6f3695d1`. An older OpenAI realtime bridge
was removed upstream; the reach assessment does not rely on that retired path.

Linux x64, AMD EPYC 9555, 128 logical CPUs, shared host. The three-way measurement
run began at load averages 70.21/76.30/57.58 and ended at 59.32/73.21/57.16.
Seven serial, interleaved sample groups after two warmups; small inputs batched.
Seeded varied bytes, not the repetitive input from the earlier investigation.
Times are median milliseconds per complete facts call:

| Decoded bytes represented | Shape        | Existing JS | JS table control | Rust/WASM adapter |
| ------------------------: | ------------ | ----------: | ---------------: | ----------------: |
|                       160 | canonical    |     0.00268 |          0.00187 |          0.000362 |
|                       960 | canonical    |     0.01687 |          0.01004 |          0.001686 |
|                     3,840 | canonical    |     0.07493 |          0.04607 |          0.006713 |
|                    65,536 | canonical    |       1.518 |            0.937 |             0.494 |
|                 1,048,576 | canonical    |      24.602 |           15.700 |             8.409 |
|                 1,048,576 | whitespace   |      24.768 |           17.555 |            12.300 |
|                 1,048,576 | late invalid |      23.682 |           14.929 |             8.228 |
|                16,777,216 | canonical    |     352.354 |          257.916 |           124.134 |
|                16,777,216 | whitespace   |     373.870 |          285.040 |           194.664 |
|                16,777,216 | late invalid |     335.045 |          193.967 |           121.902 |

At 1 MiB canonical input, the adapter was 65.8% below existing JS and 46.4%
below the simple table control in median time. This establishes neither a
universal Rust advantage nor a shipped OpenClaw improvement. Shape/branch
predictability strongly affects these numbers: the earlier repetitive-input
probe was much faster for existing JS. Do not compare separate runs as if they
were the same workload.

24,038 differential calls per implementation passed against the existing source,
plus ABI bounds/import/memory checks. The module is 710 bytes. After the largest
workload its retained linear memory was 24,051,712 bytes (22.94 MiB). A 1 MiB
fresh-instance first call retained 2,490,368 bytes; median instance setup was
about 0.086 ms and first call about 8.55 ms. These are fresh instances in one
process, not cold-process startup or a full process memory budget.

Raw JSON includes all seven samples, process CPU, and observed maxima. Seven-
sample nearest-rank p95 is only the maximum batch, not robust tail latency.
For example, 1 MiB canonical observed maxima were 27.02 ms existing JS versus
8.54 ms WASM in the captured run; consult your rerun rather than treating host
numbers as a maintained threshold.

A repeat through the final formatted script also passed all differential checks.
At 1 MiB canonical input its medians were 22.817 / 12.772 / 8.247 ms
(existing JS / table control / WASM); at 16 MiB, 362.040 / 238.256 /
127.753 ms. The shared host remained busy (load about 108). This supports the
direction of the isolated result, not stable production latency.

CPU profiling is opt-in:

```sh
node --cpu-prof --cpu-prof-dir=.openclaw/tmp/wasm-base64-experiment \
  scripts/perf/wasm-base64/measure.mjs --profile-base
node --cpu-prof --cpu-prof-dir=.openclaw/tmp/wasm-base64-experiment \
  scripts/perf/wasm-base64/measure.mjs --profile-table
node --cpu-prof --cpu-prof-dir=.openclaw/tmp/wasm-base64-experiment \
  scripts/perf/wasm-base64/measure.mjs --profile-wasm
```

These execute parity setup and then 100 calls on a 1 MiB payload, not a Gateway
request. Captured profiles locate the baseline work in the scanner/alphabet
decoder, and the candidate work in the WASM scanner. They do not establish the
scanner's percentage of real product CPU.

## Decision

Keep one validation-only experiment, not a stacked production port. Base64 is a
credible bounded large-media kernel; decide between a simpler JS improvement
and WASM only after measuring the complete attachment flow and accepting memory
and packaging costs. Per-frame audio calls are repeated but individually small;
frequency alone is insufficient. Defer the PCM-loop port. Keep fs-safe's existing
native/WASM split and all application/host authority unchanged.
