# Design: Self-Managed Backends

Gemmaclaw provisions and manages three local LLM backends so that users can run Gemma models without pre-installing any runtime. This document describes the architecture.

## Backend Choices

| Backend   | Best for            | API surface                 | Model format |
| --------- | ------------------- | --------------------------- | ------------ |
| Ollama    | GPU setups, ease    | Native REST + OpenAI-compat | Ollama tags  |
| llama.cpp | Flexible quants     | OpenAI-compat (`/v1/...`)   | GGUF files   |
| gemma.cpp | CPU-only, small RAM | Shim wrapping CLI binary    | safetensors  |

## Directory Layout

All managed files live under `$GEMMACLAW_HOME` (default `~/.gemmaclaw`):

```
~/.gemmaclaw/
  runtimes/
    ollama/           # Ollama binary (single file, chmod 755)
    llama-cpp/        # Extracted llama.cpp release (bin/llama-server)
    gemma-cpp/
      source/         # Cloned gemma.cpp repo (shallow, pinned tag)
      build/          # cmake build output (gemma binary)
  models/
    ollama/           # Ollama model blobs (OLLAMA_MODELS points here)
    llama-cpp/        # Downloaded GGUF files
    gemma-cpp/        # model.sbs + tokenizer.spm
```

## Integrity Checks

- **Downloads**: every `downloadFile()` call computes SHA-256 on the fly. When `expectedSha256` is provided, a mismatch deletes the partial file and throws.
- **Temp-file rename**: downloads write to `<dest>.download` first, then atomic `rename()` on success, so interrupted downloads never leave corrupt files.
- **Build verification**: after `cmake --build`, the manager checks that the expected binary exists at the known path.

## Process Supervision

Each manager's `start()` spawns the backend as a **detached child process** (`child.unref()`). The returned `RuntimeHandle` holds:

- `pid`: for cleanup via `process.kill(pid, SIGTERM)`
- `port`: the bound port
- `apiBaseUrl`: `http://127.0.0.1:<port>`
- `stop()`: sends SIGTERM

Health readiness is confirmed by polling a health endpoint (`waitForHealthy`) with configurable timeout (Ollama: 15s, llama.cpp: 60s for model load, gemma.cpp shim: 10s).

No persistent daemon or PID file is used. The caller (CLI or E2E harness) owns the process lifetime.

## OpenAI-Compatible API Surface

All three backends expose (or are shimmed to expose) `/v1/chat/completions`. This lets the rest of Gemmaclaw treat them uniformly through the same OpenAI-compatible provider path:

- **Ollama**: native `/v1/chat/completions` (built-in).
- **llama.cpp**: native `/v1/chat/completions` (built-in).
- **gemma.cpp**: `gemmacpp-shim.ts` wraps the CLI binary with an HTTP server that translates chat completion requests into stdin/stdout calls to the `gemma` binary, formatting prompts with Gemma turn markers.

## How OpenClaw Points to Each Backend

The `provision` CLI command starts the backend and prints the `apiBaseUrl`. The user (or a setup wizard) writes this into the OpenClaw config as a custom provider endpoint:

```json
{
  "providers": {
    "local-gemma": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "models": ["gemma3:1b"]
    }
  }
}
```

The `verifyCompletion()` function sends a test chat message and asserts a non-empty reply, confirming the full pipeline works.

## Default Models

Each backend has a pinned smallest-known-working model (see `model-registry.ts`):

| Backend   | Model                     | Size    |
| --------- | ------------------------- | ------- |
| Ollama    | `gemma3:1b`               | ~815 MB |
| llama.cpp | `gemma-3-1b-it-q4_0.gguf` | ~726 MB |
| gemma.cpp | `gemma-2-2b-it`           | ~5 GB   |

## E2E Testing

The Docker E2E harness (`test/e2e/Dockerfile.provision`) builds Gemmaclaw from source in a clean container, then runs `provision-e2e.sh` which:

1. Provisions each backend (install runtime, pull model).
2. Sends an independent `curl` request to `/v1/chat/completions`.
3. Asserts the response contains non-empty content.
4. Cleans up the backend process.

gemma.cpp requires `HF_TOKEN` for model downloads (gated model). If unset, the test is skipped.
