# ExecuTorch Voxtral OSS Readiness — Implementation Log

**Date:** 2026-03-11  
**Author:** Young Han (with AI assistance)  
**Status:** Operational — validated in `executorch` conda env

---

## Overview

Made the ExecuTorch Voxtral 4B on-device STT integration fully OSS-ready by addressing build artifact hygiene, graceful degradation, sensible path defaults, workspace configuration, documentation, and local-only file exclusion.

---

## Completed Work

### Phase 1: `.gitignore` Hygiene ✅

**File:** `/Users/younghan/project/openclaw/.gitignore`

Added exclusions for:

```gitignore
# Native extension build artifacts
extensions/*/build/
extensions/*/*.node

# Local planning & architecture docs
*.plan.md
context.md
progress.md
report.md
onepager.md
*.excalidraw
*.excalidraw.png
voxtral-runtime-openclaw-architecture.png
*.code-workspace
.cursor/
```

---

### Phase 2: pnpm Workspace Configuration ✅

#### 2.1: `pnpm-workspace.yaml`

Added `@openclaw/executorch` to `onlyBuiltDependencies` so `node-gyp rebuild` actually runs:

```yaml
onlyBuiltDependencies:
  - "@openclaw/executorch"
  - "@lydell/node-pty"
  # ... other deps
```

#### 2.2: `extensions/executorch/package.json`

Made install script failure non-fatal:

```json
"install": "node-gyp rebuild || echo '[executorch] Native addon build skipped — on-device STT will not be available. See extensions/executorch/README.md'"
```

---

### Phase 3: Path Default Improvements ✅

All hardcoded developer-local paths replaced with `~/.openclaw/` convention.

#### 3.1: `extensions/executorch/index.ts`

```typescript
// Before:
const DEFAULT_RUNTIME_LIBRARY_PATH = path.join(os.homedir(), "executorch/cmake-out/...");
const DEFAULT_MODEL_ROOT = path.join(os.homedir(), "project/executorch-examples/voice/models");

// After:
const DEFAULT_RUNTIME_LIBRARY_PATH =
  process.env.OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY?.trim() ||
  path.join(os.homedir(), ".openclaw/lib", defaultRuntimeLibraryFileName());
const DEFAULT_MODEL_ROOT =
  process.env.OPENCLAW_EXECUTORCH_MODEL_ROOT?.trim() ||
  path.join(os.homedir(), ".openclaw/models/voxtral");
```

#### 3.2: `extensions/executorch/src/cli.ts`

Same changes as index.ts.

#### 3.3: `apps/macos/Sources/OpenClaw/ExecuTorchSTTBridge.swift`

```swift
// Runner fallback:
// Before: ~/executorch/cmake-out/examples/models/voxtral_realtime/voxtral_realtime_runner
// After:  ~/.openclaw/bin/voxtral_realtime_runner

// Model dir fallback:
// Before: ~/project/executorch-examples/voice/models/voxtral-realtime-metal
// After:  ~/.openclaw/models/voxtral/voxtral-realtime-metal
```

---

### Phase 4: Graceful Degradation ✅

#### 4.1: `extensions/executorch/src/runner-manager.ts`

Changed eager native addon loading to lazy:

```typescript
// Before:
private readonly native = loadNativeExecuTorchAddon(); // throws immediately

// After:
private _native: NativeExecuTorchAddon | null = null;
private get native(): NativeExecuTorchAddon {
  if (!this._native) this._native = loadNativeExecuTorchAddon();
  return this._native;
}
```

#### 4.2: `extensions/executorch/index.ts`

Added startup availability check in `gateway_start` hook that logs warning instead of crashing:

```typescript
api.registerHook("gateway_start", () => {
  try {
    const { loadNativeExecuTorchAddon } = require("./src/native-addon.js");
    loadNativeExecuTorchAddon();
    api.logger.info("[executorch] Native addon loaded successfully");
  } catch {
    api.logger.warn("[executorch] Native addon not available — on-device STT will not work...");
  }
});
```

#### 4.3: `extensions/executorch/src/provider.ts`

Added try/catch with actionable error message pointing to README.md.

---

### Phase 5: Extension README ✅

**File:** `/Users/younghan/project/openclaw/extensions/executorch/README.md`

Created comprehensive setup guide with:

- Quick Start section (4 commands)
- Prerequisites table
- Step-by-step instructions for:
  1. Enabling the plugin (`npx openclaw config set plugins.entries.executorch.enabled true`)
  2. Building ExecuTorch runtime library
  3. Downloading model files
  4. Building native addon
- Configuration options
- CLI usage
- macOS Talk Mode setup
- Troubleshooting section

---

### Phase 6: Git Hygiene Verification ✅

Verified all local-only files are excluded:

```bash
git check-ignore -v .cursor/plans/*.plan.md context.md progress.md report.md ...
# All files correctly matched by .gitignore rules
```

---

### Phase 7: Runtime Self-Heal + Safe Audio Validation ✅

#### 7.1: Automatic macOS OpenMP dependency rewrite

**Files:**

- `/Users/younghan/project/openclaw/extensions/executorch/src/runtime-library.ts` (new)
- `/Users/younghan/project/openclaw/extensions/executorch/src/runner-manager.ts`
- `/Users/younghan/project/openclaw/extensions/executorch/src/cli.ts`

Added runtime preflight logic for macOS that:

1. Detects legacy dependency references to:
   - `/opt/llvm-openmp/lib/libomp.dylib`
2. Resolves available replacement candidates from:
   - `OPENCLAW_EXECUTORCH_LIBOMP_PATH`
   - `$CONDA_PREFIX/lib/libomp.dylib`
   - `/opt/homebrew/opt/libomp/lib/libomp.dylib`
   - `/usr/local/opt/libomp/lib/libomp.dylib`
3. Rewrites dependency in-place using `install_name_tool -change ...`
4. Logs a clear patch message and proceeds with embedded runtime load

This removes the need for manual symlink hacks under `/opt/llvm-openmp/...`.

#### 7.2: Empty PCM protection before native runtime

**File:**

- `/Users/younghan/project/openclaw/extensions/executorch/src/audio-convert.ts`

Added a hard guard after ffmpeg conversion:

- if converted PCM buffer is empty, throw a clear actionable error:
  - `ffmpeg produced empty PCM output ... re-encode to WAV/PCM and retry`

This prevents native runtime aborts caused by invalid/empty converted audio.

---

## Issues Discovered & Fixed

### Issue 1: Plugin Not Enabled by Default

**Problem:** Running `npx openclaw executorch` gave `error: unknown command 'executorch'`

**Root Cause:** The executorch plugin is discovered but **disabled** by default.

**Fix:** Added explicit enable step to README:

```bash
npx openclaw config set plugins.entries.executorch.enabled true
```

### Issue 2: Node.js Version Requirement

**Problem:** README said Node.js ≥18, but `openclaw.mjs` requires ≥22.12

**Fix:** Updated README to show correct requirement: Node.js ≥22.12

### Issue 3: Shared Library Not Built by Default

**Problem:** `make voxtral_realtime-metal` only builds the runner binary, not `libvoxtral_realtime_runtime.dylib`

**Root Cause:** The CMakeLists.txt defines `voxtral_realtime_runtime` as a SHARED library, but the Makefile workflow preset doesn't include it.

**Fix:** Must build the library target explicitly after the make:

```bash
make voxtral_realtime-metal
cmake --build cmake-out/examples/models/voxtral_realtime --target voxtral_realtime_runtime
```

### Issue 4: OpenMP Dependency

**Problem:** `dlopen` failed with `Library not loaded: /opt/llvm-openmp/lib/libomp.dylib`

**Root Cause:** The ExecuTorch runtime library was built with a hardcoded path to libomp that doesn't exist on user machines.

**Fix Options:**

1. Install libomp and create symlink:
   ```bash
   brew install libomp
   sudo mkdir -p /opt/llvm-openmp/lib
   sudo ln -sf /opt/homebrew/opt/libomp/lib/libomp.dylib /opt/llvm-openmp/lib/libomp.dylib
   ```
2. Set `DYLD_LIBRARY_PATH=/opt/homebrew/opt/libomp/lib` before running
3. Rebuild ExecuTorch with correct RPATH

---

## Files Modified

| File                                                    | Change                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `.gitignore`                                            | Added build artifact + local file exclusions                |
| `pnpm-workspace.yaml`                                   | Added `@openclaw/executorch` to `onlyBuiltDependencies`     |
| `extensions/executorch/package.json`                    | Made install script failure non-fatal                       |
| `extensions/executorch/index.ts`                        | Replaced dev paths with `~/.openclaw/`, added startup check |
| `extensions/executorch/src/cli.ts`                      | Mirrored path default changes                               |
| `extensions/executorch/src/runner-manager.ts`           | Deferred native addon loading (lazy getter)                 |
| `extensions/executorch/src/provider.ts`                 | Added actionable error messages                             |
| `apps/macos/Sources/OpenClaw/ExecuTorchSTTBridge.swift` | Replaced dev fallback paths                                 |

## Files Created

| File                                          | Description               |
| --------------------------------------------- | ------------------------- |
| `extensions/executorch/README.md`             | Comprehensive setup guide |
| `extensions/executorch/IMPLEMENTATION_LOG.md` | This file                 |

---

## Current State

### What Works ✅

- Plugin discovery and enable/disable
- CLI commands (`status`, `setup`, `transcribe`, `voice-agent`)
- Model file download via `executorch setup`
- Native addon builds during `pnpm install`
- Graceful degradation when addon missing
- Embedded transcription validated from `executorch` conda env (`metal`, real WAV sample)
- Automatic macOS OpenMP install-name patching for runtime dylib load
- Safe user-facing error for empty/invalid audio conversions (no native crash)

### What Needs Attention ⚠️

1. **ExecuTorch upstream build ergonomics** (optional upstream improvement):
   - include `voxtral_realtime_runtime` target directly in common workflow presets
   - avoid legacy hardcoded OpenMP install-name in macOS builds

---

## Testing Commands

```bash
# 1. Enable plugin
npx openclaw config set plugins.entries.executorch.enabled true

# 2. Check status
npx openclaw executorch status

# 3. Download models (if needed)
npx openclaw executorch setup --backend metal

# 4. Build shared library (in executorch repo)
cd ~/project/executorch
make voxtral_realtime-metal
cmake --build cmake-out/examples/models/voxtral_realtime --target voxtral_realtime_runtime
cp cmake-out/examples/models/voxtral_realtime/libvoxtral_realtime_runtime.dylib ~/.openclaw/lib/

# 5. Fix OpenMP dependency
brew install libomp
# OpenClaw now auto-patches legacy libomp install-name in runtime dylib on first load.
# Optional explicit override:
export OPENCLAW_EXECUTORCH_LIBOMP_PATH=/opt/homebrew/opt/libomp/lib/libomp.dylib

# 6. Test transcription
npx openclaw executorch transcribe ~/path/to/audio.wav
```

---

## Key File Locations

| Purpose                    | Path                                                       |
| -------------------------- | ---------------------------------------------------------- |
| Runtime library            | `~/.openclaw/lib/libvoxtral_realtime_runtime.dylib`        |
| Model files                | `~/.openclaw/models/voxtral/voxtral-realtime-metal/`       |
| Runner binary (macOS Talk) | `~/.openclaw/bin/voxtral_realtime_runner`                  |
| Native addon               | `extensions/executorch/build/Release/voxtral_runtime.node` |
| CLI implementation         | `extensions/executorch/src/cli.ts`                         |
| Plugin entry               | `extensions/executorch/index.ts`                           |

---

## Environment Variables

| Variable                              | Description                   |
| ------------------------------------- | ----------------------------- |
| `OPENCLAW_EXECUTORCH_MODEL_ROOT`      | Override model directory root |
| `OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY` | Override runtime library path |
| `OPENCLAW_EXECUTORCH_NATIVE_ADDON`    | Override native addon path    |

---

## Next Steps

1. Fix the OpenMP dependency issue permanently (either in ExecuTorch build or document workaround)
2. Test end-to-end transcription after libomp fix
3. Optionally submit PR to ExecuTorch repo to:
   - Add `voxtral_realtime_runtime` target to Makefile workflow
   - Fix libomp RPATH for macOS builds

---

## Handoff Update — 2026-03-11 (Embedded Talk Mode Runtime Migration)

### Scope and motivation

Migrated macOS Talk Mode STT from subprocess execution (`voxtral_realtime_runner`) to embedded runtime calls via Voxtral C API so Talk Mode and CLI both use the same embedded runtime model path.

This update was made because local mac app end-to-end verification is not available on this laptop, so the handoff is documented for continuation on another machine.

### Changed files

- `apps/macos/Sources/OpenClaw/ExecuTorchRuntimeFFI.swift` (new)
  - Added runtime FFI loader using `dlopen`/`dlsym` for:
    - `vxrt_runner_create`
    - `vxrt_runner_create_streaming_session`
    - `vxrt_session_feed_audio`
    - `vxrt_session_flush`
    - destroy/error APIs
  - Added streaming controller wrapper and token callback bridge.
- `apps/macos/Sources/OpenClaw/ExecuTorchSTTBridge.swift`
  - Removed `Process`/stdin/stdout runner lifecycle.
  - Added embedded runtime lifecycle (`loadModel`, streaming session create/feed/flush/destroy).
  - Kept mic capture + AVAudioConverter path and now feeds float samples directly to runtime session.
  - Runtime library lookup now uses:
    - `OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY` if set
    - app bundled `libvoxtral_realtime_runtime.dylib`
    - fallback `~/.openclaw/lib/libvoxtral_realtime_runtime.dylib`
- `extensions/executorch/src/cli.ts`
  - `setup --backend metal` no longer requires/downloads `voxtral_realtime_runner`.
  - Setup still ensures Talk Mode streaming model/preprocessor assets are present.
- `extensions/executorch/README.md`
  - Updated docs to reflect embedded-runtime Talk Mode (no subprocess runner requirement).
- `.cursor/rules/executorch-cross-device-handoff.mdc` (new)
  - Added persistent rule for cross-device handoff logging discipline.

### Verification run and results

- `xcrun swiftc -typecheck ... ExecuTorchRuntimeFFI.swift ExecuTorchSTTBridge.swift` -> **PASS**
- `pnpm openclaw executorch setup --backend metal` -> **PASS**
- `pnpm openclaw executorch status` -> **PASS**
- `pnpm openclaw executorch transcribe ~/executorch/obama_short20.wav` -> **FAIL in this environment**
  - Failure: Metal device initialization (`ETMetalStream: Failed to create Metal device`)
  - Interpretation: environment/device/runtime access issue on this laptop/session, not a compile-level regression in the migration itself.

### Known blockers and assumptions

- Real macOS app Talk Mode end-to-end was **not** validated here due local environment limitations.
- Current validation confirms compile/typecheck and CLI setup/status paths, but not full app runtime behavior under menu-bar Talk Mode.

### Follow-up commands for next agent/laptop

```bash
# 1) Pull latest branch and install deps
cd /Users/younghan/project/openclaw
pnpm install

# 2) Ensure runtime/model assets are present
pnpm openclaw executorch setup --backend metal
pnpm openclaw executorch status

# 3) Build/run mac app locally and test Talk Mode
./scripts/package-mac-app.sh
open dist/OpenClaw.app

# 4) Force Talk Mode STT backend to ExecuTorch
defaults write ai.openclaw.mac openclaw.talkSttBackend executorch

# 5) Relaunch app and verify:
#    - Talk Mode loads embedded runtime
#    - no subprocess runner launch
#    - transcript tokens arrive while speaking
```
