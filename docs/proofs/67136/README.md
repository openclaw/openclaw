# Real behavior proof — issue #67136 / PR #67202

This directory contains a reproducible, runnable real-behavior proof for the
write-tool false-success bug reported in
[#67136](https://github.com/openclaw/openclaw/issues/67136) and the post-write
verifier fix in [#67202](https://github.com/openclaw/openclaw/pull/67202).

## What's here

- `repro.mjs` — a self-contained Node script that:
  1. Reproduces the pre-fix symptom (`Successfully wrote N bytes` while the
     file does not actually exist) using the exact `WriteOperations.writeFile`
     `Promise<void>` contract the upstream `@earendil-works/pi-coding-agent`
     write tool consumed.
  2. Imports `verifyHostFile`, `verifyWrittenStat`, and
     `WriteVerificationError` **directly from the PR source**
     (`src/agents/pi-tools.write-verification.ts`) and exercises every failure
     mode covered by the fix on a real on-disk write path.
  3. Exercises the host-edit recovery contract added in this PR — verifier
     errors must be rethrown rather than masked by readback heuristics.
- `repro-output.txt` — a redacted capture of the live terminal output produced
  by running `repro.mjs` on a host setup. Paths under `/var/folders/...` (on
  macOS) or `/tmp/...` (on Linux) are real `os.tmpdir()` paths used and cleaned
  up by the script.

## How to run

From the repo root:

```bash
# Node 23.6+ (default behavior, strips TS types natively)
node docs/proofs/67136/repro.mjs

# Node 22.6-23.5
node --experimental-strip-types docs/proofs/67136/repro.mjs
```

The script exits non-zero if either the pre-fix bug fails to reproduce or any
of the post-fix verifier checks fails to fire.

## Why this is real-behavior proof, not a unit test

- It is not a Vitest file. It does not mock the verifier; it calls the
  shipped functions on the host fs and emits the exact human-readable error
  strings users will see at runtime.
- Scenario A drives the same `Promise<void>`-resolves-without-write symptom
  the upstream sandbox bridge produced for the reporter (#67136 was filed
  against OpenClaw `2026.4.14` on Ubuntu 24.04 with DeepSeek; the symptom is
  reproducible at the WriteOperations contract layer on any host).
- Scenarios B and C show the verifier's three runtime error strings verbatim
  — these are the strings agents and downstream tooling will surface to users
  when a write silently fails after this PR lands.
- Scenario D demonstrates the recovery wrapper contract: a verifier failure
  must not be turned into a fake "Successfully replaced…" string.

The captured output in `repro-output.txt` is the after-fix evidence; ten of
the eleven assertions exercise the post-fix code path on a real filesystem.
