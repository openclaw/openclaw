# GitHub Copilot agent runtime (OpenClaw plugin)

External OpenClaw plugin that registers a `copilot` agent harness backed by `@github/copilot-sdk` and the GitHub Copilot CLI.

## Install

```bash
openclaw plugins install @openclaw/copilot
```

Restart the Gateway after installing or updating the plugin.

The harness claims the `github-copilot` subscription provider plus
custom BYOK provider entries that the Copilot SDK can represent. Manifest-owned
native provider ids stay with their owning runtimes. The harness is opt-in only:
selection requires explicit `agentRuntime.id: "copilot"` on a model or provider
entry; `auto` never picks it. OpenClaw remains the default embedded runtime.

See [GitHub Copilot agent runtime](../../docs/plugins/copilot.md) for
configuration, the doctor contract, transcript mirroring, compaction, side
questions, replay, and the supported-surface contract.

## Package

- Plugin id: `copilot`
- Package: `@openclaw/copilot`
- Minimum OpenClaw host: `2026.5.28`

## Transcript journal benchmark

From the repository root, use synthetic state in a disposable directory and run:

```bash
OPENCLAW_STATE_DIR=/path/to/isolated-state \
NODE_OPTIONS="--import=$(pwd)/extensions/copilot/test/journal-allocation-probe.mjs" \
node --import ./scripts/tsx.mjs extensions/copilot/test/bench-attempt-transcript-journal.ts --history-mib 1
```

Use a fresh state directory for each process. Supported history sizes are `0.25`,
`1`, and `4` MiB. The benchmark excludes seeding and warmup, then completes ten
fresh tool groups and replays them. It reports group timings, sampled allocation
bytes including collected objects, and bytes of history JSON decoded in the main
isolate and SQLite workers. Interleave baseline and candidate runs at least five
times per size. With only 50 group timings per side, p95 and p99 are context only.
The workload exercises the real journal and transcript SDK without provider calls.
