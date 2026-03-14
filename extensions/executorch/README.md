# ExecuTorch Voxtral Plugin for OpenClaw

On-device speech-to-text (STT) for OpenClaw using ExecuTorch + Voxtral Realtime.

- No cloud STT calls
- No API keys for transcription
- Audio stays local on your machine

---

## 1) Fastest Start (No local ExecuTorch build)

This is the shortest path for users. It assumes your HF model repo includes both model files and runtime library.

### Step A: Prerequisites

- Node.js `>= 22.12`
- `pnpm` (via Corepack)
- `ffmpeg`

```bash
# macOS helpers
brew install ffmpeg libomp
corepack enable
```

### Step B: Install OpenClaw dependencies

From the OpenClaw repo root:

```bash
pnpm install
```

### Step C: Enable plugin

```bash
pnpm openclaw config set plugins.entries.executorch.enabled true
```

### Step D: Download everything needed

```bash
pnpm openclaw executorch setup --backend metal
```

`setup` downloads:

- required model files (`model*.pte`, `preprocessor.pte`, `tekken.json`)
- runtime library (`libvoxtral_realtime_runtime.*`) when present in the same HF repo
- on macOS + `--backend metal`, Talk Mode streaming model/preprocessor assets

### Step E: Verify setup

```bash
pnpm openclaw executorch status
```

Expected: all components show `OK`.

### Step F: Run transcription

```bash
pnpm openclaw executorch transcribe ~/executorch/obama_short20.wav
```

---

## 2) Backend Choices

### Metal (macOS Apple Silicon)

- Best default on Apple Silicon

```bash
pnpm openclaw executorch setup --backend metal
```

### XNNPACK (CPU)

- CPU-only fallback

```bash
pnpm openclaw executorch setup --backend xnnpack
```

### CUDA (Linux + NVIDIA)

- Runtime is supported
- Auto-download bundle is not configured in this plugin yet
- Place files manually in:

```text
~/.openclaw/models/voxtral/voxtral-realtime-cuda/
```

Required files:

- `model.pte`
- `preprocessor.pte`
- `tekken.json`
- `aoti_cuda_blob.ptd`

---

## 3) Common Commands

```bash
# Check readiness (runtime + model + tokenizer + preprocessor)
pnpm openclaw executorch status

# Download model files (+ runtime, if published in repo)
pnpm openclaw executorch setup --backend metal

# Transcribe one file
pnpm openclaw executorch transcribe path/to/audio.wav

# Run private voice agent demo
pnpm openclaw executorch voice-agent --ollama-model llama3.2:3b --record-duration 5
```

---

## 4) Publish Runtime Binaries to HF (maintainer)

Yes — this is the right way to remove the local ExecuTorch build requirement for users.

Recommended runtime artifact names:

- macOS: `libvoxtral_realtime_runtime.dylib`
- Linux: `libvoxtral_realtime_runtime.so`
- Windows (future): `voxtral_realtime_runtime.dll`

Recommended placement:

- Put runtime binaries at repo root (same level as `model*.pte`, `preprocessor*.pte`, `tekken.json`)

After upload, users only run:

1. `pnpm install`
2. `pnpm openclaw config set plugins.entries.executorch.enabled true`
3. `pnpm openclaw executorch setup --backend metal`
4. `pnpm openclaw executorch transcribe <audio.wav>`

---

## 5) Default Paths

OpenClaw uses these defaults unless overridden:

- Runtime library:
  - macOS: `~/.openclaw/lib/libvoxtral_realtime_runtime.dylib`
  - Linux: `~/.openclaw/lib/libvoxtral_realtime_runtime.so`
- Model root: `~/.openclaw/models/voxtral`
- Backend model dirs:
  - metal: `~/.openclaw/models/voxtral/voxtral-realtime-metal`
  - xnnpack: `~/.openclaw/models/voxtral/voxtral-realtime-xnnpack`
  - cuda: `~/.openclaw/models/voxtral/voxtral-realtime-cuda`

---

## 6) Environment Variables

| Variable                                    | Purpose                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `OPENCLAW_EXECUTORCH_MODEL_ROOT`            | Override model root directory                                                         |
| `OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY`       | Override runtime library path                                                         |
| `OPENCLAW_EXECUTORCH_NATIVE_ADDON`          | Override compiled `.node` path                                                        |
| `OPENCLAW_EXECUTORCH_LIBOMP_PATH`           | macOS override path for `libomp.dylib`                                                |
| `OPENCLAW_EXECUTORCH_SKIP_LIBOMP_REWRITE=1` | Skip automatic macOS libomp dependency rewrite                                        |
| `OPENCLAW_EXECUTORCH_DEBUG=1`               | Enable verbose STT/FFI logs (Mac app; per-token and poll logs)                        |
| `OPENCLAW_EXECUTORCH_USE_STREAMING=1`       | Reserved for when runtime fixes streaming callback; currently still uses offline poll |

---

### Current Talk Mode runtime state

- **Active path:** Offline polling. The Mac app records mic audio into a ring buffer (16 kHz mono) and periodically runs `vxrt_runner_transcribe` on a short window (1–2s). Tokens are delivered via the same callback used for file transcription; this path is stable.
- **Streaming path:** Disabled. The C API streaming session (`vxrt_runner_create_streaming_session` + `vxrt_session_feed_audio`) has a callback lifetime bug: tokens are not delivered to Swift and the session can crash after ~160 feeds. When the runtime dylib is fixed, set `OPENCLAW_EXECUTORCH_USE_STREAMING=1` and implement fallback to offline poll on first stream error.

### Known limitations and next steps

- **TTS/echo:** ExecuTorch has no echo cancellation. During TTS playback the app mutes transcript emission (`setEmissionEnabled(false)`) so the mic does not re-transcribe the speaker; capture stays running. With earphones, leakage can still be picked up; if TTS repeatedly interrupts itself, ensure emission is muted during `.speaking`.
- **Endpointing / tail word:** Silence timeout (e.g. 700 ms) can fire before the last decode finishes, so the final word may be missing. Next steps: longer ExecuTorch-specific silence window and/or a final flush decode before send.
- **Performance:** First-token latency is typically 1.5–3.5 s (poll interval + decode). Tuning: adaptive poll cadence (bootstrap ~280 ms, active ~400 ms, idle ~800 ms), VAD gate to skip decode when quiet, ring buffer for rolling audio, and optional latency metrics (`executorch.stt: latency firstToken p50=...` in logs when `OPENCLAW_EXECUTORCH_DEBUG` is unset for summary only).

---

## 7) Troubleshooting

### `error: unknown command 'executorch'`

Plugin is disabled. Enable it:

```bash
pnpm openclaw config set plugins.entries.executorch.enabled true
```

### `spawn pnpm ENOENT` (inside conda env)

Your conda shell does not expose `pnpm` yet:

```bash
corepack enable
```

Then retry.

### Runtime load error mentions `/opt/llvm-openmp/lib/libomp.dylib`

OpenClaw auto-patches this legacy dependency on macOS when possible. If needed:

```bash
brew install libomp
export OPENCLAW_EXECUTORCH_LIBOMP_PATH=/opt/homebrew/opt/libomp/lib/libomp.dylib
```

### `ExecuTorch files not found` or runtime missing

Re-run setup:

```bash
pnpm openclaw executorch setup --backend metal
```

If runtime is still missing, upload runtime binary to HF repo (Section 4) or use fallback local build (Section 8).

### `ffmpeg produced empty PCM output`

Input decoded to empty PCM (unsupported/malformed). Re-encode and retry:

```bash
ffmpeg -y -i input.any -ar 16000 -ac 1 output.wav
pnpm openclaw executorch transcribe output.wav
```

### Native addon build issues

```bash
cd extensions/executorch
npx node-gyp rebuild
```

macOS toolchain:

```bash
xcode-select --install
```

---

## 8) Hustles & gotchas

Notes from real usage and Mac app integration.

### Plugin shows disabled / "Error: bundled (disabled by default)"

Bundled plugins are disabled by default. That’s expected, not a failure. Enable and restart:

```bash
pnpm openclaw config set plugins.entries.executorch.enabled true
# Restart gateway: quit Mac app and reopen, or:
pnpm openclaw gateway restart
```

Before enabling, `pnpm openclaw plugins info executorch` should show disabled with a hint to enable (no Error line). After enabling and restarting, it should no longer show as disabled.

### Mac app build: Swift 6 Sendable errors in ExecuTorchSTTBridge

The macOS app’s ExecuTorch STT bridge lives in `apps/macos/Sources/OpenClaw/ExecuTorchSTTBridge.swift`. Under Swift 6 strict concurrency it can fail with “sending value of non-Sendable type” or “passing closure as a 'sending' parameter” when:

- Passing non-Sendable C runtime/session holders across queue boundaries.
- Capturing actor state directly from C callback trampolines or audio tap callbacks.
- Using the `AVAudioConverter` input callback with mutable local state without synchronization.

Fixes applied in this repo: `@preconcurrency import AVFoundation`; isolate C runtime/session behind Sendable-safe wrappers; hop back to the actor using `Task`; lock around the converter’s single-use `consumed` flag.

### Talk Mode (Mac) vs CLI vs web

- **Mac app**: Menubar → Talk Mode; STT backend can be ExecuTorch (embedded runtime, no subprocess). No equivalent in the web UI.
- **CLI**: Use `pnpm openclaw executorch voice-agent` or `pnpm openclaw executorch transcribe <file>` for realtime or file transcription. This uses the extension’s embedded runtime path.
- **Web**: No Talk Mode; use the CLI for ExecuTorch transcription.

To prep Mac Talk Mode in one command:

```bash
pnpm openclaw executorch setup --backend metal
```

This command now fetches the runtime + streaming model assets used by the macOS app. Talk Mode **requires** `preprocessor-streaming.pte` (not only `preprocessor.pte`); the app will fail to load the model with a clear error if only the non-streaming preprocessor is present.

**Use Voxtral in Talk Mode:** The Mac app defaults to Apple Speech. Switch to ExecuTorch Voxtral using the correct defaults domain for how you run the app:

- **Packaged app** (e.g. `dist/OpenClaw.app` from `./scripts/package-mac-app.sh`): the bundle ID is usually `ai.openclaw.mac.debug`. Run:
  ```bash
  defaults write ai.openclaw.mac.debug openclaw.talkSttBackend executorch
  ```
- **Run from Xcode** (raw executable under `Build/Products/Debug/OpenClaw`): the process does **not** use `ai.openclaw.mac.debug`; its bundle ID is whatever the system assigns. Use the **debug hint** in the Talk Mode chat: when STT is Apple Speech, the first message includes a line like `(bundle=..., raw=.... To use Voxtral run: defaults write <id> openclaw.talkSttBackend executorch)`. Run that exact command with the shown `<id>`, then quit and relaunch from Xcode. Alternatively, run the packaged app and attach the debugger so one `defaults write ai.openclaw.mac.debug ...` works.

Then quit and reopen the app (or turn Talk Mode off and on). To confirm Voxtral is active, check the next Talk Mode message for `STT: ExecuTorch Voxtral.`, or in **Console.app** search for `executorch` / `openclaw` and look for `talk STT backend: ExecuTorch Voxtral` or `falling back to Apple Speech`.

To switch back to Apple Speech: `defaults write <bundleId> openclaw.talkSttBackend apple` (use the same bundle ID you used for executorch).

### Gateway must be restarted after enabling plugin

After `config set plugins.entries.executorch.enabled true`, the running gateway does not reload plugins. Restart the Mac app or run `openclaw gateway restart` so the executorch plugin is loaded.

### SIGABRT in `vxrt_runner_create` (Talk Mode / macOS app)

If the app aborts with **signal SIGABRT** when creating the Voxtral runner (log line: `executorch.stt: runtime loaded, creating runner...` then crash), the runtime dylib is likely failing an internal check. Common causes:

1. **Model and runtime version mismatch** — The runtime (`libvoxtral_realtime_runtime.dylib`) and the model/preprocessor files must come from the same Voxtral/ExecuTorch build. Re-run setup so all assets are from the same source:  
   `pnpm openclaw executorch setup --backend metal`
2. **Corrupt or wrong model file** — Ensure the Metal streaming model and preprocessor are present and not truncated:  
   `ls -la ~/.openclaw/models/voxtral/voxtral-realtime-metal/*.pte`
3. **Verify via CLI** — If the same runtime works from the CLI, the issue may be limited to the app environment (e.g. Metal device or sandbox):  
   `pnpm openclaw executorch transcribe /path/to/short.wav`
4. **Warmup** — The Mac app creates the runner with warmup enabled. Warmup pre-compiles Metal shaders during model loading so the first `feed_audio` call is fast. If you see a SIGABRT during model loading, ensure the streaming model and `preprocessor-streaming.pte` are compatible.

5. **EXC_BAD_ACCESS when closing Talk Mode** — If the app crashes in `sessionFlush` when you turn Talk Mode off, the runtime dylib may be invalidating the session or not support flush on the calling thread. The app workaround is to **not** call `session_flush` on stop (only `session_destroy`). If you need final tokens on stop, the runtime must allow flush from the same thread that feeds audio or document thread requirements.

6. **Streaming session callback not used (offline poll instead)** — The C API `vxrt_runner_create_streaming_session` plus `vxrt_session_feed_audio` can produce tokens inside the runtime (`newTokens > 0`) but the Swift token callback is never invoked; after ~160 feeds the session can crash with EXC_BAD_ACCESS. This points to a callback/lifetime bug in the C wrapper (e.g. `std::function` for the token callback not stored or invoked correctly in the C++ `StreamingSession`). Until the runtime is fixed, Talk Mode uses **offline polling**: it records audio into a ring buffer and periodically calls `vxrt_runner_transcribe` on a short window (1–2s), which does invoke the callback and is stable. **Guarded reintroduction:** When the runtime dylib is updated to fix the streaming callback, set `OPENCLAW_EXECUTORCH_USE_STREAMING=1` in the app environment to try the streaming path; the app should fall back to offline poll on first stream error so behavior remains safe.

---

## 9) Fallback Local Runtime Build (only if HF runtime is missing)

Use this only when runtime binaries are not yet published to HF:

```bash
conda activate executorch
cd ~/executorch
make voxtral_realtime-metal
cmake --build cmake-out/examples/models/voxtral_realtime --target voxtral_realtime_runtime
mkdir -p ~/.openclaw/lib
cp cmake-out/examples/models/voxtral_realtime/libvoxtral_realtime_runtime.dylib ~/.openclaw/lib/
```

---

## 10) Manual Model Download (Optional)

If you prefer manual download over `setup`:

```bash
# Metal
huggingface-cli download younghan-meta/Voxtral-Mini-4B-Realtime-2602-ExecuTorch-Metal   --local-dir ~/.openclaw/models/voxtral/voxtral-realtime-metal

# XNNPACK
huggingface-cli download younghan-meta/Voxtral-Mini-4B-Realtime-2602-ExecuTorch-XNNPACK   --local-dir ~/.openclaw/models/voxtral/voxtral-realtime-xnnpack
```

---

## 11) macOS Talk Mode Note

The macOS app Talk Mode now uses the embedded ExecuTorch runtime via the Voxtral C API (no `voxtral_realtime_runner` subprocess).
The OpenClaw extension path (`pnpm openclaw executorch ...`) also uses embedded runtime.
