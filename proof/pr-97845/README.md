# PR #97845 — streamed invoke recognizer grammar-drift proof

Real-behavior proof that the streamed-prefix invoke recognizer
(`isViableXmlishInvokeOpenPrefix` in `packages/tool-call-repair/src/stream-normalizer.ts`)
now accepts the same whitespace-flexible attribute-dialect invoke grammar as the
final parser, so a grammar-legal split form no longer leaks as visible text
mid-stream.

## What it does

`harness.ts` drives the **real** stream normalizer
(`normalizePlainTextToolCallStreamEvents`) through the same option wiring that
`src/plugin-sdk/provider-stream-shared.ts` uses to wrap a provider stream
(matcher / `createPromotedToolCallEvents` / `normalizeDoneMessage`). It feeds a
fake degraded provider stream that emits an attribute-dialect invoke open whose
`name` attribute has whitespace around the keyword and the equals sign
(`<invoke name = "exec">`), split across chunks at those whitespace boundaries,
followed by a parameter block and the closing tags.

Two scenarios run against the same fake stream:

- **BEFORE** — a scratch copy of `stream-normalizer.ts` with
  `isViableXmlishInvokeOpenPrefix` reverted to the pre-fix literal-prefix logic
  (captured in `old-recognizer.fragment.ts` from the parent commit). The split
  form is classified `impossible` mid-stream and the buffered text is flushed as
  visible `text_delta` events — the leak.
- **AFTER** — the real (fixed) package source. The same bytes stay buffered and
  promote into a `toolcall_start` / `toolcall_delta` + `done(reason: toolUse)`
  sequence with no visible text.

The scratch copy lives only in the container's temp dir; the real repository
source is never modified.

## Run it

```sh
proof/pr-97845/run-proof.sh
```

This builds the Docker image, runs the harness in the container with the repo
bind-mounted at `/work`, and prints + saves captured output under
`proof/pr-97845/output/` (`before.txt`, `after.txt`, `summary.txt`). The harness
asserts the BEFORE leak and the AFTER promotion, and fails (non-zero exit) if
either does not hold. It also self-checks captured output against a redaction
allow-list (no absolute paths, credentials, or vendor/AI identity tokens).

The demo tool name (`exec`) and argument (`command: "echo demo"`) are benign
placeholders; no provider key is required because the stream is synthetic.

## Files

- `harness.ts` — proof runner (drives the real normalizer; does not reimplement it).
- `old-recognizer.fragment.ts` — pre-fix recognizer spliced in for the BEFORE run.
- `Dockerfile` — `node:22-slim` + pinned `tsx`.
- `run-proof.sh` — single entrypoint.
- `output/` — captured BEFORE/AFTER event streams and summary.
