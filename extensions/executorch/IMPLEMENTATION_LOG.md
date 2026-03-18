# Parakeet-TDT Metal Migration Log

## Objective

Replace Voxtral-realtime with an embedded Parakeet-TDT Metal runtime for OpenClaw, including:

- extension runtime migration
- macOS Talk Mode FFI migration
- metal-only setup/status/transcribe flow
- one-command setup path
- HF publication of required runtime artifact

## Branch

- `feat/parakeet-tdt-metal-macos`

## Completed Work

### 1) Migration scaffold

- Created a dedicated migration branch.
- Captured legacy Voxtral hotspots in extension and macOS bridge paths.

### 2) Parakeet C ABI runtime (ExecuTorch local tree)

Implemented a new C ABI wrapper in local ExecuTorch:

- added `examples/models/parakeet/parakeet_c_api.h`
- added `examples/models/parakeet/parakeet_c_api.cpp`
- added shared target `parakeet_tdt_runtime` in `examples/models/parakeet/CMakeLists.txt`

Build output:

- `cmake-out/examples/models/parakeet/libparakeet_tdt_runtime.dylib`

Exported symbols verified:

- `pqt_runner_create`
- `pqt_runner_destroy`
- `pqt_runner_transcribe`
- `pqt_last_error`

### 3) HF artifact publication

Published runtime artifact to:

- [https://huggingface.co/younghan-meta/Parakeet-TDT-ExecuTorch-Metal](https://huggingface.co/younghan-meta/Parakeet-TDT-ExecuTorch-Metal)

Uploaded file:

- `libparakeet_tdt_runtime.dylib`

Upload commit:

- [https://huggingface.co/younghan-meta/Parakeet-TDT-ExecuTorch-Metal/commit/5ce0a795bed7fef4ca050ce9718e273b11a6a162](https://huggingface.co/younghan-meta/Parakeet-TDT-ExecuTorch-Metal/commit/5ce0a795bed7fef4ca050ce9718e273b11a6a162)

### 4) Extension migration (metal-only)

Refactored extension internals from Voxtral to Parakeet:

- backend narrowed to `metal`
- default model root changed to `~/.openclaw/models/parakeet/parakeet-tdt-metal`
- default runtime library changed to `libparakeet_tdt_runtime.dylib`
- setup command now downloads Parakeet model/runtime bundle from one HF repo

Native addon migration:

- replaced `native/voxtral_runtime_addon.cc` with `native/parakeet_runtime_addon.cc`
- switched `binding.gyp` target/source to `parakeet_runtime`
- switched loaded C symbols from `vxrt_*` to `pqt_*`
- addon output now `parakeet_runtime.node`

### 5) macOS Talk Mode migration

FFI runtime bridge migrated to Parakeet C ABI:

- replaced `vxrt_*` symbol loading with `pqt_*`
- removed preprocessor path/config from runner creation
- removed streaming-session ABI assumptions from Swift runtime layer

STT bridge migration:

- runtime default path switched to `libparakeet_tdt_runtime.dylib`
- model directory switched to `~/.openclaw/models/parakeet/parakeet-tdt-metal`
- model/tokenizer defaults switched to `model.pte` + `tokenizer.model`
- offline polling path retained as active decode strategy

### 6) Cleanup and defaults

- updated provider model id to `parakeet-tdt-0.6b-v3`
- updated `src/media-understanding/defaults.ts` executorch default model
- updated Talk Mode labels/copy from Voxtral to Parakeet-TDT
- updated relevant tests referencing legacy backend label text

## Current Runtime Contract

### Extension + addon

- C ABI symbols expected from runtime dylib:
  - `pqt_runner_create`
  - `pqt_runner_destroy`
  - `pqt_runner_transcribe`
  - `pqt_last_error`

### Artifact contract for setup

- HF repo: `younghan-meta/Parakeet-TDT-ExecuTorch-Metal`
- required files:
  - `model.pte`
  - `tokenizer.model`
  - `libparakeet_tdt_runtime.dylib`

## Remaining Validation (executed in verification phase)

- `pnpm build`
- `pnpm check`
- `pnpm openclaw executorch setup`
- `pnpm openclaw executorch status`
- `pnpm openclaw executorch transcribe <short.wav>`
- macOS Talk Mode final-word acceptance run

## Risk Notes

- Parakeet migration is intentionally metal-only; non-macOS-arm64 hosts are unsupported.
- Runtime/model mismatch can still cause launch failures; setup flow now enforces a single bundle source to reduce drift.

## Handoff Update — 2026-03-18 (PR 50051 review triage)

- [x] Scope and motivation
- [x] Changed files
- [x] Verification run + results
- [x] Known blockers and assumptions
- [x] Follow-up commands for next agent

### What changed and why

- Added `extensions/executorch/PR50051_REVIEW_TRIAGE.md`.
- Purpose: review the live PR feedback on #50051, check whether each comment is still valid against the current branch, and draft paste-ready GitHub responses for the next agent/operator.

### Changed files

- `extensions/executorch/PR50051_REVIEW_TRIAGE.md`
- `extensions/executorch/IMPLEMENTATION_LOG.md`

### Verification run + results

- `gh api repos/openclaw/openclaw/pulls/50051/comments --paginate --jq '.[] | [.user.login, .path, (.line|tostring), .body] | @tsv'`
  - pass
  - confirmed six live inline review comments
- Local source inspection:
  - `extensions/executorch/index.ts`
  - `extensions/executorch/src/runner-manager.ts`
  - `extensions/executorch/src/provider.ts`
  - `src/media-understanding/runner.entries.ts`
  - `src/media-understanding/defaults.ts`
  - `apps/macos/Sources/OpenClaw/TalkModeRuntime.swift`
  - `apps/macos/Sources/OpenClaw/ExecuTorchSTTBridge.swift`
  - `extensions/executorch/native/parakeet_runtime_addon.cc`
  - result: four review comments are still real pre-merge blockers, one is valid cleanup, one is a valid follow-up/perf concern

### Known blockers and assumptions

- Still not merge-ready as of this review pass.
- Pre-merge blockers identified from review triage:
  - ESM `require()` bug in `extensions/executorch/index.ts`
  - `RunnerManager.ensureReady()` concurrent launch race
  - keyless `executorch` provider still forced through API-key auth in media-understanding path
  - Talk Mode bridge remains stuck after initial ExecuTorch load failure
- Lower-priority items:
  - redundant `fs.access()` checks in runner path validation
  - synchronous N-API transcription still blocks Node event loop
- No new real-app validation was performed in this step; this was source-level review triage only.

### Follow-up commands for next agent

- Read `extensions/executorch/PR50051_REVIEW_TRIAGE.md`
- Fix the four blocker items before marking PR ready
- Re-run targeted verification after fixes:
  - `pnpm tsgo`
  - `pnpm check`
  - `pnpm openclaw executorch status`
  - `pnpm openclaw executorch transcribe <short.wav>`
  - macOS Talk Mode retry test after intentionally failing then restoring ExecuTorch files

## Handoff Update — 2026-03-18 (PR 50051 blocker fixes)

- [x] Scope and motivation
- [x] Changed files
- [x] Verification run + results
- [x] Known blockers and assumptions
- [x] Follow-up commands for next agent

### What changed and why

- Resolved the main issues called out in `extensions/executorch/PR50051_REVIEW_TRIAGE.md`:
  - fixed ESM-safe addon preload in `extensions/executorch/index.ts`
  - fixed `RunnerManager.ensureReady()` concurrent-launch race
  - removed redundant model/tokenizer re-checks in runner path validation
  - added first-class keyless execution support for local media providers and marked ExecuTorch as keyless
  - reset Talk Mode ExecuTorch bridge state on model-load failure so retry does not require app restart
  - moved native Parakeet transcription off the main Node thread via N-API async work
- Added regression tests for the new TypeScript behavior and a Swift test seam for the Talk Mode load-failure fallback.

### Changed files

- `extensions/executorch/index.ts`
- `extensions/executorch/index.test.ts`
- `extensions/executorch/src/provider.ts`
- `extensions/executorch/src/runner-manager.ts`
- `extensions/executorch/src/runner-manager.test.ts`
- `extensions/executorch/src/native-addon.ts`
- `extensions/executorch/native/parakeet_runtime_addon.cc`
- `src/media-understanding/types.ts`
- `src/media-understanding/runner.entries.ts`
- `src/media-understanding/runner.entries.test.ts`
- `apps/macos/Sources/OpenClaw/TalkModeRuntime.swift`
- `apps/macos/Sources/OpenClaw/ExecuTorchSTTBridge.swift`
- `apps/macos/Tests/OpenClawIPCTests/TalkModeRuntimeSpeechTests.swift`
- `extensions/executorch/IMPLEMENTATION_LOG.md`

### Verification run + results

- `pnpm vitest run --config vitest.extensions.config.ts extensions/executorch/index.test.ts extensions/executorch/src/runner-manager.test.ts`
  - pass
- `pnpm vitest run --config vitest.unit.config.ts src/media-understanding/runner.entries.test.ts`
  - pass
- `pnpm tsgo`
  - pass
- `pnpm build:native` (inside `extensions/executorch`)
  - pass
- `ReadLints` on edited TS/Swift/C++ files
  - pass
- `swift test --filter TalkModeRuntimeSpeechTests` (inside `apps/macos`)
  - failed twice due external Sparkle binary download timeout:
    - `https://github.com/sparkle-project/Sparkle/releases/download/2.9.0/Sparkle-for-Swift-Package-Manager.zip`
  - this did **not** fail on a source assertion/test expectation; it failed before package resolution completed

### Known blockers and assumptions

- TypeScript/plugin-side review blockers are addressed in code and covered by focused regression tests.
- macOS-side source fix is implemented, and a Swift test was added, but the test could not be executed in this session because SwiftPM could not fetch Sparkle.
- Real app validation is still recommended before merge:
  - Talk Mode with ExecuTorch enabled
  - force a missing-runtime/model failure, then restore files and verify retry without app restart
  - confirm normal Apple Speech fallback still works

### Follow-up commands for next agent

- `pnpm vitest run --config vitest.extensions.config.ts extensions/executorch/index.test.ts extensions/executorch/src/runner-manager.test.ts`
- `pnpm vitest run --config vitest.unit.config.ts src/media-understanding/runner.entries.test.ts`
- `pnpm tsgo`
- `pnpm --dir extensions/executorch build:native`
- retry Swift verification when network/package fetch is healthy:
  - `cd apps/macos && swift test --filter TalkModeRuntimeSpeechTests`
- run manual macOS Talk Mode retry scenario with broken/restored ExecuTorch artifacts

## Handoff Update — 2026-03-18 (PR 50051 GitHub reply prep)

- [x] Scope and motivation
- [x] Changed files
- [x] Verification run + results
- [x] Known blockers and assumptions
- [x] Follow-up commands for next agent

### What changed and why

- Added `extensions/executorch/PR50051_GITHUB_REPLIES.md`.
- Purpose: provide exact paste-ready reply bodies and per-thread resolution guidance for the current GitHub review comments on PR #50051, matching the fixes that were implemented in this branch.

### Changed files

- `extensions/executorch/PR50051_GITHUB_REPLIES.md`
- `extensions/executorch/IMPLEMENTATION_LOG.md`

### Verification run + results

- Source review against current fixes:
  - confirmed reply text matches the implemented ESM preload fix
  - confirmed reply text matches the `RunnerManager` race/path-validation fixes
  - confirmed reply text matches the keyless-provider auth-path fix
  - confirmed reply text matches the Talk Mode fallback reset change
  - confirmed reply text matches the async N-API transcription change

### Known blockers and assumptions

- Reply file is prepared but review comments were **not** posted/resolved automatically in this step.
- Swift test caveat still applies in the reply text: local execution is blocked by Sparkle fetch timeout in this environment.

### Follow-up commands for next agent

- Open `extensions/executorch/PR50051_GITHUB_REPLIES.md`
- Paste replies into the PR review threads
- Resolve each review thread after posting the matching reply
