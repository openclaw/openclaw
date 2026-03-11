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

- Put runtime binary at repo root (same level as `model*.pte`, `preprocessor.pte`, `tekken.json`)

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

| Variable                                    | Purpose                                        |
| ------------------------------------------- | ---------------------------------------------- |
| `OPENCLAW_EXECUTORCH_MODEL_ROOT`            | Override model root directory                  |
| `OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY`       | Override runtime library path                  |
| `OPENCLAW_EXECUTORCH_NATIVE_ADDON`          | Override compiled `.node` path                 |
| `OPENCLAW_EXECUTORCH_LIBOMP_PATH`           | macOS override path for `libomp.dylib`         |
| `OPENCLAW_EXECUTORCH_SKIP_LIBOMP_REWRITE=1` | Skip automatic macOS libomp dependency rewrite |

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

## 8) Fallback Local Runtime Build (only if HF runtime is missing)

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

## 9) Manual Model Download (Optional)

If you prefer manual download over `setup`:

```bash
# Metal
huggingface-cli download younghan-meta/Voxtral-Mini-4B-Realtime-2602-ExecuTorch-Metal   --local-dir ~/.openclaw/models/voxtral/voxtral-realtime-metal

# XNNPACK
huggingface-cli download younghan-meta/Voxtral-Mini-4B-Realtime-2602-ExecuTorch-XNNPACK   --local-dir ~/.openclaw/models/voxtral/voxtral-realtime-xnnpack
```

---

## 10) macOS Talk Mode Note

The macOS app Talk Mode currently uses `voxtral_realtime_runner` for streaming STT.
The OpenClaw extension path (`pnpm openclaw executorch ...`) uses embedded runtime.
