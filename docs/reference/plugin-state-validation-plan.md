# Agentic validation plan for the SQLite plugin state store

## 1. Desired operating model

Validation should be a closed loop that an agent can run, interpret, fix against, and rerun without manual command choreography.

Target local command:

```bash
pnpm plugin-state:validate --profile full --json
```

Target cross-platform command:

```bash
pnpm plugin-state:validate:remote --profile full --ref ak/sqlite-plugin-state-store --json
```

The agent loop should be:

1. Run validation.
2. Parse the structured JSON summary.
3. If validation fails, identify the failed phase, job, threshold, or platform.
4. Inspect only the relevant logs and artifacts.
5. Patch the implementation, harness, or threshold.
6. Rerun the smallest failed profile.
7. Stop when green or when a clear blocker remains.

The validator should avoid requiring a human to remember separate unit, E2E, load, Windows, Linux, and macOS commands.

## 2. Add a real automated E2E fixture plugin

Because `api.runtime.state.openKeyedStore` is bundled-plugin-only in this implementation, the E2E path should use a test-only bundled fixture plugin rather than a manually installed external plugin.

Proposed fixture:

```text
test/fixtures/plugins/plugin-state-smoke/
  openclaw.manifest.json
  src/index.ts
```

The fixture should call the real runtime API:

```ts
const store = api.runtime.state.openKeyedStore<SmokeRecord>({
  namespace: "smoke",
  defaultTtlMs: 60_000,
  maxEntries: 100,
});
```

The plugin should expose deterministic operations for the harness:

- `write(key, value)`
- `read(key)`
- `consume(key)`
- `list()`
- `writeWithTtl(key, value, ttlMs)`
- `writeMany(count, payloadBytes)`
- `probe()`

Acceptance criteria:

- The fixture is loaded through the real plugin loader, or the closest existing fixture-loader path.
- The fixture receives `api.runtime.state.openKeyedStore` from the runtime proxy.
- The runtime proxy binds the plugin id automatically.
- Values persist across runtime, gateway, or store restart.
- Two fixture plugins using the same namespace and key cannot see each other's data.
- A non-bundled plugin path still rejects `openKeyedStore` access.

## 4. Add an automated load runner

Add an agent-friendly load script:

```text
scripts/load/plugin-state-store-load.ts
```

Expose it through package scripts:

```json
{
  "plugin-state:load": "tsx scripts/load/plugin-state-store-load.ts"
}
```

Example invocation:

```bash
pnpm plugin-state:load \
  --duration-ms 60000 \
  --plugins 20 \
  --namespaces 10 \
  --concurrency 64 \
  --payload-bytes 1024 \
  --read-ratio 0.45 \
  --write-ratio 0.45 \
  --consume-ratio 0.10 \
  --json
```

The runner must be non-interactive, deterministic enough for CI, and emit JSON on both success and failure.

Example output shape:

```json
{
  "ok": true,
  "profile": "default",
  "durationMs": 60000,
  "operations": {
    "total": 183204,
    "reads": 82102,
    "writes": 82431,
    "consumes": 18671,
    "errors": 0
  },
  "latencyMs": {
    "p50": 1.2,
    "p95": 7.9,
    "p99": 21.4,
    "max": 88.3
  },
  "sqlite": {
    "dbBytes": 10485760,
    "walBytes": 4194304,
    "probeOk": true
  },
  "thresholds": {
    "maxErrors": 0,
    "maxP99Ms": 100,
    "maxWalBytes": 134217728
  }
}
```

Recommended profiles:

| Profile              | Duration | Purpose                                           |
| -------------------- | -------: | ------------------------------------------------- |
| `smoke`              |      10s | Fast local and PR validation                      |
| `stress`             |      60s | Normal contention and load signal                 |
| `multiprocess`       |  60-120s | SQLite lock and WAL behavior across processes     |
| `restart-under-load` |      60s | shutdown, close, reopen, and persistence behavior |
| `soak`               |   10-30m | pre-release or nightly validation only            |

Load dimensions to cover:

- Single-process async mixed reads, writes, consumes, and entries calls.
- Multi-process contention against the same `OPENCLAW_STATE_DIR`.
- Per-plugin live-row cap enforcement.
- Namespace eviction through `maxEntries`.
- 64KB boundary and 64KB+1 rejection.
- TTL churn and sweep behavior.
- Large namespace listing at 1,000 live entries.
- Close, reopen, and probe after load.

The runner should exit non-zero when thresholds fail and write a JSON artifact under `.artifacts/plugin-state-validation/` even on failure.

## 5. Add a single local orchestrator command

Add:

```text
scripts/validation/plugin-state-validate.ts
```

Expose it through package scripts:

```json
{
  "plugin-state:validate": "tsx scripts/validation/plugin-state-validate.ts"
}
```

Supported profiles:

```bash
pnpm plugin-state:validate --profile smoke --json
pnpm plugin-state:validate --profile full --json
pnpm plugin-state:validate --profile load --json
```

Suggested phase selection:

### `smoke`

- `pnpm tsgo`
- `pnpm test src/plugin-state/plugin-state-store.test.ts`
- `pnpm test src/plugin-state/plugin-state-store.e2e.test.ts`
- `pnpm test src/plugins/runtime/index.test.ts`
- `pnpm plugin-state:load --profile smoke --json`

### `full`

- all `smoke` phases
- `pnpm check:changed`
- `pnpm test:changed`
- `pnpm plugin-state:load --profile stress --json`
- `pnpm plugin-state:load --profile multiprocess --json`

### `load`

- load profiles only, for focused SQLite/store iteration.

The orchestrator should write a single summary file:

```text
.artifacts/plugin-state-validation/summary.json
```

Example summary:

```json
{
  "ok": false,
  "profile": "full",
  "failedPhase": "load:multiprocess",
  "phases": [
    {
      "name": "unit",
      "ok": true,
      "durationMs": 6200
    },
    {
      "name": "load:multiprocess",
      "ok": false,
      "durationMs": 60000,
      "artifact": ".artifacts/plugin-state-validation/load-multiprocess.json",
      "failureSummary": "3 SQLITE_BUSY errors escaped threshold maxErrors=0"
    }
  ],
  "nextRecommendedCommand": "pnpm plugin-state:load --profile multiprocess --json"
}
```

This summary is the primary interface for agentic retry and debugging.

## 6. Add cross-platform GitHub Actions validation

Add a manual and PR-triggerable workflow:

```text
.github/workflows/plugin-state-store-validation.yml
```

Suggested matrix:

```yaml
strategy:
  fail-fast: false
  matrix:
    os:
      - ubuntu-latest
      - windows-latest
      - macos-latest
    node:
      - 22.x
```

Optional nightly or manual broad matrix:

```yaml
node:
  - 22.x
  - 24.x
```

Suggested workflow inputs:

```yaml
workflow_dispatch:
  inputs:
    profile:
      type: choice
      options: [smoke, full, load, soak]
      default: smoke
    load_duration_ms:
      default: "60000"
    ref:
      required: false
```

Validation job behavior:

1. Check out the requested ref or exact SHA.
2. Install dependencies.
3. Run:

   ```bash
   pnpm plugin-state:validate --profile "${{ inputs.profile }}" --json
   ```

4. Upload `.artifacts/plugin-state-validation/` as an artifact.

Summary job behavior:

1. Download all matrix artifacts.
2. Combine per-platform summaries into:

   ```text
   plugin-state-validation-summary.json
   plugin-state-validation-summary.md
   ```

3. Fail the workflow if any matrix entry failed.

Cross-platform acceptance criteria:

- Ubuntu, Windows, and macOS all run the same validation profile.
- Windows skips only POSIX permission assertions.
- Linux and macOS verify plugin state directory and SQLite file permissions.
- Windows verifies path handling, close/reopen behavior, and SQLite sidecar cleanup under Windows file-locking semantics.
- Artifacts are structured enough for an agent to consume without opening the Actions UI.

## 7. Add a remote closed-loop runner

Add:

```text
scripts/validation/plugin-state-remote.ts
```

Expose it through package scripts:

```json
{
  "plugin-state:validate:remote": "tsx scripts/validation/plugin-state-remote.ts"
}
```

Example invocation:

```bash
pnpm plugin-state:validate:remote \
  --workflow plugin-state-store-validation.yml \
  --profile full \
  --ref ak/sqlite-plugin-state-store \
  --wait \
  --json
```

The remote runner should:

1. Resolve the current branch or SHA.
2. Dispatch the validation workflow.
3. Poll the exact workflow run.
4. Download artifacts.
5. Print a machine-readable summary.
6. Exit non-zero if validation failed.

Example failure summary:

```json
{
  "ok": false,
  "runUrl": "https://github.com/openclaw/openclaw/actions/runs/123",
  "headSha": "abc123",
  "failedJobs": [
    {
      "os": "windows-latest",
      "node": "22.x",
      "phase": "load:multiprocess",
      "summary": "database remained locked after close/reopen",
      "artifact": ".artifacts/plugin-state-remote/windows-load-summary.json"
    }
  ],
  "nextRecommendedAction": {
    "kind": "fix",
    "command": "pnpm plugin-state:load --profile multiprocess --json"
  }
}
```

## 8. Use Testbox or GitHub Actions depending on the phase

Use local execution or Testbox for:

- quick Linux parity
- `pnpm check:changed`
- focused load profiles
- iteration with warm dependencies

Use GitHub Actions for:

- Windows proof
- macOS proof
- official PR artifacts
- reusable cross-platform evidence

Given that Blacksmith may not be installed everywhere, GitHub Actions should be the primary cross-platform path. Testbox support can remain an optional acceleration path for maintainers.

## 9. Agent loop algorithm

The closed loop should be bounded and explicit:

```text
max_iterations = 5

for iteration in 1..max_iterations:
  run pnpm plugin-state:validate --profile smoke --json

  if local smoke fails:
    parse summary
    inspect targeted logs/artifacts
    patch root cause
    rerun failed phase
    continue

  run pnpm plugin-state:validate:remote --profile full --ref current-branch --wait --json

  if remote full passes:
    report success and artifacts
    stop

  classify failure:
    - implementation bug
    - test or harness bug
    - load threshold too strict
    - platform-specific filesystem behavior
    - infrastructure or flake

  if implementation/test/harness bug:
    patch
    run smallest local proof
    continue

  if infrastructure/flaky:
    rerun failed job once
    continue

  stop with blocker summary and artifact links
```

The loop should never blindly rerun full validation forever.

## 10. Failure classification rules

The validator should classify failures in JSON so the next agent action is obvious.

Implementation bug:

```json
{
  "classification": "implementation",
  "reason": "lookup returned a value after consume",
  "phase": "e2e:consume"
}
```

Platform-specific bug:

```json
{
  "classification": "platform",
  "platform": "windows-latest",
  "reason": "database file remained locked after closePluginStateSqliteStore"
}
```

Load regression:

```json
{
  "classification": "performance",
  "reason": "p99 latency 187ms exceeded threshold 100ms",
  "phase": "load:stress"
}
```

SQLite contention:

```json
{
  "classification": "sqlite-contention",
  "reason": "SQLITE_BUSY escaped retry/busy_timeout policy",
  "phase": "load:multiprocess"
}
```

Infrastructure or flake:

```json
{
  "classification": "infrastructure",
  "reason": "GitHub-hosted Windows runner lost network during install",
  "rerunAllowed": true
}
```

## 11. Implementation order

Recommended order:

1. Add the test-only bundled fixture plugin.
2. Add the load runner and JSON artifact schema.
3. Add the local validation orchestrator.
4. Add the GitHub Actions matrix workflow.
5. Add the remote dispatcher and artifact downloader.
6. Wire failure classification and next-command recommendations.
7. Tune thresholds after at least one successful Linux, Windows, and macOS run.

## 12. Final acceptance target

The feature is agentically validated when this passes:

```bash
pnpm plugin-state:validate --profile full --json
```

and this passes on Ubuntu, Windows, and macOS:

```bash
pnpm plugin-state:validate:remote --profile full --ref ak/sqlite-plugin-state-store --wait --json
```

Artifacts should show:

- unit validation green
- plugin fixture smoke green
- restart persistence green
- load smoke/stress green
- multi-process contention green
- no escaped SQLite lock errors
- no database corruption
- diagnostics probe green after load
- structured summaries available for future agent reruns
