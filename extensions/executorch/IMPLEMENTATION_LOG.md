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
