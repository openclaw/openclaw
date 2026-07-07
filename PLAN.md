# OpenClaw Fix Plan

> Source-verified bottlenecks from `PROBLEM.md`.
> Fixes mapped to proven DX ecosystem tools at `G:\Dx`.
> Targets: smaller install, faster startup, lower memory.

## How OpenClaw Runs Models

OpenClaw runs models **almost exclusively via external servers** (Ollama, LM Studio, vLLM, HuggingFace, all cloud providers). The only native in-process execution is `node-llama-cpp` in the `llama-cpp` extension, and that is **embeddings only** — no chat/generation runs in-process.

| Extension       | Execution                                    | Chat | Embeddings |
| --------------- | -------------------------------------------- | ---- | ---------- |
| `ollama`        | External HTTP (`localhost:11434`)            | Yes  | Yes        |
| `lmstudio`      | External HTTP (`localhost:1234`)             | Yes  | Yes        |
| `vllm`          | External HTTP (user URL)                     | Yes  | No         |
| `huggingface`   | External HTTP API                            | Yes  | No         |
| `llama-cpp`     | Native in-process via `node-llama-cpp` N-API | No   | Yes        |
| Cloud providers | External HTTPS                               | Yes  | Yes        |

No model files are bundled. `node-llama-cpp` downloads GGUF on demand to `~/.node-llama-cpp/models/`.

---

## Target: Smaller Install (362MB → ~80-100MB)

### 1. Strip TypeScript from Runtime Dependencies

**Problem:** `typescript` 6.0.3 (~50MB) shipped as `dependencies` in `package.json:2032` because `jiti` needs it for `.ts`→`.js` JIT compilation at runtime.

**Fix:** Pre-compile all `.ts` to `.js` with `esbuild` at build time. Remove `jiti` + `typescript` from runtime deps. The Tauri fork proves this: Rust CLI binary ships without any TS runtime.

**File target:** `G:\Dx\openclaw\package.json:2032`

### 2. Replace Heavy JS-Native Modules with Rust napi-rs

**Problem:** These packages ship 50-100MB of multi-platform native binaries:

| Package                                     | Est. Size | Why Heavy                             |
| ------------------------------------------- | --------- | ------------------------------------- |
| `@lydell/node-pty`                          | ~15MB     | 7 platform-specific optional binaries |
| `tree-sitter-bash` + `web-tree-sitter`      | ~10MB     | Native WASM parsers                   |
| `@silvia-odwyer/photon-node` + `rastermill` | ~15MB     | Image processing natives              |
| `quickjs-wasi`                              | ~8MB      | WASM runtime                          |
| `playwright-core`                           | ~30MB     | Browser automation driver             |

**Fix:** Use `G:\Dx\native`'s napi-rs pattern: compile Rust replacements to a **single ~6MB `.node` file per platform** via `napi build --platform --release`. Ship only the user's platform binary. The Tauri fork proves Rust napi-rs modules replace entire JS-native stacks with identical API surfaces.

**Reference pattern:** `G:\Dx\native` — Rust + napi-rs replacing JS-native modules.

### 3. Pre-Built Plugin Registry Index

**Problem:** `src/plugins/discovery.ts` (1,687 lines) scans 3 filesystem roots with `readdirSync` + `readCandidatePackageManifest()` per candidate. 50+ plugin candidates opened every startup.

**Fix:** Generate a binary `.machine` plugin registry at install time via `G:\Dx\serializer`. Startup reads the pre-built index in <1ms. No filesystem scanning.

**Reference:** `G:\Dx\serializer` `.machine` format — 229x faster reads than JSON.

---

## Target: Faster Startup (2s → <500ms)

### 4. Binary Config Cache via `.machine` Format

**Problem:** Config is JSON5, re-parsed and Zod-validated every startup. 13 serial config phases. No cache survives process restarts (`src/config/cache-utils.ts:65-150` is only process-local Map).

**Fix:** Generate a `.machine` binary cache of the resolved config snapshot at install time. On startup, read it via mmap in ~1.3us (small fixture) instead of 10-50ms for JSON5 parse + Zod validation. `G:\Dx\serializer` benchmarks show **229x faster validated reads** vs JSON parse.

**Reference:** `G:\Dx\serializer\README.md:12-21` — validated `.machine` reads 10-17x faster than JSON parse; hot mmap reads 155-229x faster.

### 5. Replace ACP Backend Busy-Poll with Event-Driven Readiness

**Problem:** `waitForAcpRuntimeBackendReady()` in `server-startup-post-attach.ts:530-555` polls `backend.healthy()` every 50ms for up to 5,000ms. Blocking synchronous loop.

**Fix:** Replace polling with a Promise-based event emitter. Backend publishes `ready` event; startup awaits it. For the Rust backend path, use `G:\Dx\native`'s tokio async channels instead of JS `setTimeout` loops.

### 6. Accept Connections Before Full Setup

**Problem:** Gateway cannot accept health checks or connections until all 13 serial config phases complete plus ACP backend ready.

**Fix:** Start HTTP listener immediately on port bind. Serve health checks (`/health`, `/ready`) while background setup completes. Defer non-critical plugin loading to post-attach. The Tauri fork proves this pattern: CLI readiness before full metadata resolution.

---

## Target: Lower Memory (581MB RSS → <200MB)

### 7. Move Session Storage Out of V8 Heap into Rust

**Problem:** Session transcripts, plugin registry, config objects, Zod schemas all live in V8 GC heap. GC must trace every live object, causing event-loop pauses proportional to heap size.

**Fix:** Use `G:\Dx\serializer` `.machine` mmap for read-heavy data (config, registry, metadata). Zero-copy mmap'd reads produce zero V8 heap allocations. Data stays in Rust-owned memory. GC never traces it.

For session storage, use the napi-rs pattern from `G:\Dx\native`: Rust-owned SQLite via `rusqlite` with a thin napi-rs binding. Sessions live outside V8; JS gets a handle to query them.

### 8. LLM Format for Tool Schemas (Token Cost Reduction)

**Problem:** Tool schemas and structured data sent to LLMs as raw JSON. No client-side token counting. Every unnecessary token = real API cost.

**Fix:** Use `G:\Dx\serializer`'s LLM format (~49% token savings vs compact JSON) for tool schemas, manifests, agent transcripts. The LLM format is designed for the exact use case: structured, repetitive, schema-familiar data going into an AI context window.

**Reference:** `G:\Dx\serializer\LLM_FORMAT_SPEC.md` — beats TOON by 11%, Tauq by 14%, TONL by 13%.

### 9. Process Safety — Eliminate `process.exit()` in Production Code

**Problem:** 22 `process.exit()` calls in production source files. Model resolver (`model-resolver.ts:513`) kills process on CLI model failure. Tool search (`tool-search.ts:411`) has `setTimeout(() => process.exit(0), 100)` — a deferred non-deterministic kill.

**Fix:** Route all exits through a single `GracefulShutdown` coordinator that drains active sessions, kills child processes, flushes state, then exits. Use `G:\Dx\native`'s Windows Job Object / Linux subreaper patterns for native child process lifecycle management. No more orphaned browser processes.

---

## Implementation Order

| Phase       | What                                             | Depends On                           | Expected Gain                           |
| ----------- | ------------------------------------------------ | ------------------------------------ | --------------------------------------- |
| **Phase 1** | Strip TypeScript from runtime, pre-compile to JS | Build pipeline change                | -50MB install                           |
| **Phase 2** | `.machine` plugin registry at install time       | `G:\Dx\serializer` crate integration | -100ms startup, removes filesystem scan |
| **Phase 3** | `.machine` config cache with mmap reads          | Phase 2 (serializer tooling)         | -10-50ms startup, -200MB RSS            |
| **Phase 4** | Replace JS-native modules with Rust napi-rs      | `G:\Dx\native` patterns              | -50-100MB install                       |
| **Phase 5** | Session store in Rust-owned SQLite via napi-rs   | Phase 4 (napi-rs toolchain)          | -200MB RSS, eliminates GC pauses        |
| **Phase 6** | Process safety — single exit coordinator         | Phase 5                              | Zero orphaned processes                 |
| **Phase 7** | LLM format for tool schemas                      | `G:\Dx\serializer` LLM format        | ~49% fewer tokens                       |
| **Phase 8** | Event-driven ACP readiness, deferred startup     | Phase 3                              | -5s worst-case startup                  |

**Bold targets:** 80-100MB install, <500ms cold startup, <200MB RSS.
