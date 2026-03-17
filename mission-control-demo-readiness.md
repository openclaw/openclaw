# Mission Control Demo Readiness (Deterministic Scenarios)

## 1) Fully seeded case

**Goal:** show seed-backed behavior with no indexed project files.

- Trigger:
  - Ensure `agentFilesList` is empty/null and no mission project files are hydrated.
- Expected:
  - Provenance callout indicates seed-backed mode.
  - Pills show `seed-backed` where applicable.

## 2) Mixed / provenance-degraded case

**Goal:** show mixed state from preloaded/cached content.

- Trigger:
  - Provide `agentFileContents` for mission files without indexed metadata.
- Expected:
  - Provenance callout indicates mixed mode.
  - Adapter notes include stale/freshness metadata caveats.

## 3) Unavailable / malformed-input case

**Goal:** verify unavailable handling and warning visibility.

- Trigger:
  - Set `06_seed_data.json` to malformed JSON.
- Expected:
  - Provenance state includes `unavailable`.
  - Surface callout warns that some signals are unavailable.

## 4) Live / fresh indexed-file-content case

**Goal:** show fully live path.

- Trigger:
  - Provide indexed metadata + content for `TASK_QUEUE.md`, `PROJECT_MEMORY.md`, `TEAM_OPERATING_MODEL.md`, `PROJECT_INSTRUCTIONS.md` with fresh timestamps.
- Expected:
  - Provenance state is `live`.
  - Mission cards and pills show live-state values.

## 5) Stale indexed-file-content case

**Goal:** prove stale is distinct from mixed/unavailable.

- Trigger:
  - Provide indexed metadata with timestamps older than freshness window (>10m).
- Expected:
  - Provenance includes `stale`.
  - Surface callout warns about stale signals.
