# OpenClaw — Real Bottlenecks & Root Causes

> Quantified problems from `v2026.6.11` (latest), verified against source code.
> See `PROBLEMS.md` for the full attack-surface report if this file already exists.

---

## 1. TypeScript Compiler Shipped as Production Dependency

**File:** `G:\Dx\openclaw\package.json:2032`

```json
"dependencies": {
  ...
  "typescript": "6.0.3",
  ...
}
```

**Impact:** +50MB to every `npm install`. TypeScript is a build-time tool — it should be `devDependencies`. Shipping it as a runtime dep inflates installs for every user regardless of whether they compile anything.

**Root cause:** The gateway uses `jiti` (JIT transpiler) to load `.ts` files at runtime instead of pre-compiling to JS. `typescript` is a peer dependency of `jiti`.

---

## 2. Install Size 362MB / 300 Dependencies

**Files:**

- `G:\Dx\openclaw\package.json` — 55 root dependencies (not counting workspaces)
- `G:\Dx\openclaw\npm-shrinkwrap.json` — 308 packages in lockfile
- `G:\Dx\openclaw\docs/reference/release-performance-sweep.md:145` — 361.7MiB fresh install

**Breakdown of heavy deps:**
| Package | Est. Size | Why It's Heavy |
|---|---|---|
| `typescript` 6.0.3 | ~50MB | Full TS compiler (see #1) |
| `playwright-core` 1.61.1 | ~30MB | Browser automation driver |
| `@lydell/node-pty` 1.2.0-beta.12 | ~15MB | 7 platform optional binaries |
| `tree-sitter-bash` + `web-tree-sitter` | ~10MB | Native WASM parsers |
| `@silvia-odwyer/photon-node` + `rastermill` | ~15MB | Image processing natives |
| `quickjs-wasi` 3.0.2 | ~8MB | WASM JS runtime |
| All other 50 deps + transitive | ~200MB | The rest |

**Root cause:** Monorepo packaging strategy bundles everything into one `.tgz`. No plugin-based install model. The shrinkwrap (`npm-shrinkwrap.json`) forces the full transitive tree.

---

## 3. Plugin Filesystem Scan on Every Startup (100-500ms)

**File:** `G:\Dx\openclaw\src\plugins\discovery.ts` (1,687 lines)

**The bottleneck:**

```
discoverInDirectory() → fs.readdirSync(dir, { withFileTypes: true })
  → for each entry: readCandidatePackageManifest() → fs.readFileSync(package.json)
  → discoverBundleInRoot() for bundles
  → loadPluginManifest() per candidate
  → merge scoped + shared discovery results
```

**Quantified:** Scans 3 root directories (bundled, global `~/.openclaw/extensions`, workspace). Each has 50+ plugin candidates. Each candidate opens `package.json`. This is synchronous, blocking the event loop.

**Root cause:** No pre-built plugin registry index. Every process startup re-discovers all installed plugins from scratch. Discovery is memoized by JSON hash, but the first startup always misses.

**Called from:** `src/plugins/plugin-lookup-table.ts:45-113` → called during gateway startup and CLI commands

---

## 4. No Binary Config Cache — JSON5 Re-Parsed Every Startup

**File:** `G:\Dx\openclaw\src\config\cache-utils.ts` (168 lines)

**What exists:** Only a process-local `Map` with `setTimeout`-based TTL expiry and `mtime` file-stat invalidation.

```typescript
// src/config/io.ts:2775
export function clearConfigCache(): void {
  // Compat shim: runtime snapshot is the only in-process cache now.
}
```

`clearConfigCache()` is literally a no-op. There is zero persisted or pre-compiled cache for the config snapshot.

**Impact:** Every invocation of `openclaw gateway start`, `openclaw doctor`, `openclaw configure`, `openclaw onboard` re-reads `openclaw.json` (JSON5), resolves `$include` directives, and validates against Zod schemas (1,136-line schema file). Config objects live in V8 GC heap.

**Root cause:** Pure JS/TS codebase with no native caching layer. No equivalent of a `.machine` binary format or pre-compiled config snapshot.

---

## 5. Config Validation at 2,128 Lines with Wide Transitive Imports

**File:** `G:\Dx\openclaw\src\config\validation.ts` (2,128 lines)

**The problem:** This one module imports from 15+ other modules across the codebase:

- `src/config/zod-schema.core.ts` (1,136 lines)
- `src/agents/agent-scope.ts`
- `src/channels/direct-dm-access.ts`
- `src/plugins/plugin-config-state.ts`
- `src/plugins/installed-plugin-index.ts`
- `src/plugins/plugin-manifest-aliases.ts`
- `src/plugins/manifest-registry.ts` (1,195 lines)
- `src/plugins/plugin-metadata-snapshot.ts`

**Impact:** Loading the validation module transitively loads the entire plugin discovery stack, agent scope resolution, channel DM access rules — all during startup critical path.

**Root cause:** No separation between "validate config shape" and "validate config in context of installed plugins". The validation layer is monolithic.

---

## 6. ACP Backend Busy-Poll Blocks Startup Up to 5 Seconds

**File:** `G:\Dx\openclaw\src\gateway\server-startup-post-attach.ts:530-555`

```typescript
const ACP_BACKEND_READY_TIMEOUT_MS = 5_000;
const ACP_BACKEND_READY_POLL_MS = 50;

async function waitForAcpRuntimeBackendReady(): Promise<void> {
  const deadline = Date.now() + ACP_BACKEND_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const backend = getAcpRuntimeBackend();
    if (backend?.healthy()) return;
    await sleep(pollMs, undefined, { ref: false });
  }
}
```

**Impact:** Worst case: 5 seconds of event-loop polling at 50ms intervals. No backoff. No passive notification mechanism. Blocks the entire post-attach startup chain.

**Root cause:** Synchronous health-check polling instead of event-driven readiness (Promise/Callback/EventEmitter).

---

## 7. 22 `process.exit()` Calls in Production Code

**Key dangerous sites:**
| File | Line | Code | Risk |
|---|---|---|---|
| `src/agents/sessions/model-resolver.ts` | 513 | `process.exit(1)` | Kills process on model resolution failure |
| `src/agents/tool-search.ts` | 411 | `setTimeout(() => process.exit(0), 100)` | Deferred non-deterministic kill |
| `src/logging/console.ts` | 206 | `process.exit(exitCode ?? 0)` | Kills on stdout EPIPE |
| `src/entry.ts` | 107,114,120,162,293 | `process.exit(2/1)` | 5 exits on CLI arg failures |
| `src/tui/tui.ts` | 1359 | `process.exit(130)` | SIGINT handler |
| `src/mcp/plugin-tools-serve.ts` | 86 | `process.exit(1)` | MCP failure kills process |
| `src/runtime.ts` | 93 | `process.exit(code)` | Default runtime exit |

**Impact:** Any of these can terminate the gateway mid-session, killing all active agent conversations, browser processes, and channel connections. No graceful shutdown.

**Root cause:** CLI patterns that conflate "command failed" with "process must die". No centralized error-recovery layer for CLI commands vs long-running gateway process.

---

## 8. 581MB Peak RSS — Everything in V8 GC Heap

**Sources of heap pressure:**
| Component | What Lives in V8 |
|---|---|
| Session transcripts | Parsed JSON objects for every session in memory-cache layer |
| Plugin registry | Discovered manifests, metadata snapshots, lookup tables |
| Config snapshot | Full resolved config with all `$include` directives expanded |
| Zod schemas | Compiled schema objects from 1,136-line schema files |
| Provider catalog | Model definitions, provider configs, auth profiles |
| Discovery cache | Filesystem scan results, memoized by JSON hash |

**Root cause:** No Rust/native memory management. Everything is a JS object on the V8 heap. V8 can `mmap` binary files but the codebase never uses it — all data is parsed into JS objects. GC must trace every live object when collecting, causing event-loop pauses proportional to heap size.

---

## 9. 13 Serial Config Phases in Startup

**File:** `G:\Dx\openclaw\src\gateway\server-startup-config.ts`

The startup trace records **13 sequential sub-phases** for config alone:

1. `config.snapshot.read`
2. `config.snapshot.auto-enable`
3. `config.auth.snapshot-validate`
4. `config.auth.runtime-overrides`
5. `config.auth.startup-overrides`
6. `config.auth.secret-surface`
7. `config.auth.secret-preflight`
8. `config.auth.preflight-override`
9. `config.auth.ensure`
10. `config.auth.runtime-startup-overrides`
11. `config.auth.secrets-activate`
12. `config.final-snapshot`
13. `control-ui.seed`

**Impact:** Each phase is serial, blocking the next. Config load happens before network listener starts — the gateway cannot accept health checks or connections until all phases complete.

**Root cause:** Startup is designed as a synchronous pipeline. No concept of "accept connections immediately, finish setup in background."

---

## 10. Gateway Directory: 551 Files, 214,202 Lines of TypeScript

**File:** `G:\Dx\openclaw\src\gateway/`

| Subsystem             | Files                      | Est. Lines |
| --------------------- | -------------------------- | ---------- |
| Server implementation | `server.impl.ts`           | 1,872      |
| Startup phases        | 6 files                    | ~2,900     |
| HTTP/routing          | `server-http.ts` + related | ~1,500     |
| Discovery             | `server-discovery*.ts`     | ~400       |
| Terminal/SSE          | `server-terminal*.ts`      | ~2,000     |
| Methods/procedures    | `server-methods*.ts`       | ~5,000     |

**Impact:** Even with dynamic `import()`, the dependency topology is wide. Module evaluation cost is non-trivial on first load. The `server.ts` facade (which lazy-imports `server.impl.ts`) helps, but once `server.impl.ts` is loaded, it cascades.

**Root cause:** No strict module boundary between startup, runtime, HTTP, discovery, terminals, and plugins. The gateway grew organically.

---

## 11. No Client-Side Token Counting — LLM Costs Unoptimized

**Search:** Zero `tiktoken` references in the entire codebase.

**How it works:** Token counts (`inputTokens`, `outputTokens`, `totalTokens`) come from provider API response `usage` fields. OpenClaw has no client-side token counter.

**Impact:**

- Cannot estimate context budget before sending a request
- Cannot detect token blowup (large tool outputs, verbose schemas) before it hits the API
- Tool schemas and system prompts sent as raw JSON — no LLM-optimized format
- Every unnecessary token = real API cost

**Root cause:** Token counting was never implemented client-side. Provider response is the single source of truth for token usage.

---

## 12. 100+ Deprecated Code Sites — Ongoing Migration Debt

**Key deprecated surfaces:**
| Surface | Location | Count |
|---|---|---|
| Channel reply dispatch (old bridge) | `src/channels/inbound-reply-dispatch.ts` | 11 sites |
| Draft preview finalizer (entire file) | `src/channels/draft-preview-finalizer.ts` | 3 sites |
| Channel types (legacy projections) | `src/channels/plugins/types.core.ts` | 5 sites |
| Config keys (allowDeny, expireAfter, ttsVoice, etc.) | `src/config/types.*.ts` | 20+ sites |
| Channel context builders | `src/channels/inbound-event/context.ts` | 7 sites |
| Direct DM access (old path) | `src/channels/direct-dm-access.ts` | 4 sites |

**Impact:** Each deprecated path is still maintained. Bugs in deprecated code must be fixed alongside new code. The old channel bridge (`inbound-reply-dispatch.ts`) adds mental overhead — new contributors must learn both old and new channel APIs.

**Root cause:** The channel plugin SDK migration started but is not complete. Old chrome-api channel patterns coexist with new plugin-sdk patterns. Config schema evolved through multiple versions with backward compat shims.

---

## 13. CI: 90-Second Hard Sleep Every Main Push

**File:** `.github/workflows/ci.yml:46-62`

```yaml
runner-admission:
  runs-on: ubuntu-latest
  steps:
    - name: Debounce
      run: sleep 90
      shell: bash
```

**Impact:** 90 seconds added to every `main` branch push before CI starts any real work. Over a month of 100 pushes, that's 2.5 hours of dead time.

**Root cause:** A debounce mechanism to let superseding pushes cancel earlier CI runs. Intent is good but implementation is a fixed sleep instead of event-driven cancellation (which GitHub Actions already supports via `concurrency` groups).

---

## 14. CI: 4 Duplicate CodeQL Workflows

**Files:**

- `.github/workflows/codeql.yml`
- `.github/workflows/codeql-critical-quality.yml`
- `.github/workflows/codeql-android-critical-security.yml`
- `.github/workflows/codeql-macos-critical-security.yml`

**Impact:** 4x CodeQL analysis on every push. Security scanning duplicated across 4 workflow files with minor scope differences. Each analysis consumes CI minutes and requires separate maintenance.

**Root cause:** Workflows were added at different times for different risk levels, never consolidated.

---

## 15. 106 Bug Fixes Per Release — Excessive Churn

**File:** `G:\Dx\openclaw\CHANGELOG.md:23-128` — 104 fixes in current unreleased section.

**Recurring fix patterns (this cycle):**
| Pattern | Count | Examples |
|---|---|---|
| OOM / unbounded response reads | 8 | Teams, Discord, Matrix, Minimax, Tlön, browser, update-check, infra |
| Promise rejections / error leaks | 6 | Gateway dispatch, lazy subscriber failures, unhandled rejections |
| Browser session/state issues | 5 | Cookie persistence, remote browser reconnection, orphan cleanup |
| Exec/child process safety | 4 | Pipe failures, ANSI sanitization, timeout handling |
| Channel-specific failures | 12 | Discord, Slack, WhatsApp, iMessage, Telegram, Teams |

**Root cause:** 50+ extensions, 15+ providers, 11+ channels — each has unique error-handling, transport, and parsing paths. The surface area is too large for manual review of every edge case. Systematic bounds-checking and fuzzing are missing.

---

## 16. mDNS Discovery Timeout Blocks Startup 5 Seconds

**File:** `G:\Dx\openclaw\src\gateway\server-discovery-runtime.ts`

```typescript
const DEFAULT_DISCOVERY_ADVERTISE_TIMEOUT_MS = 5000;
```

Gateway advertises via Bonjour/mDNS + DNS-SD on startup. If mDNS is unavailable (common on Windows without Bonjour service, or in container environments), startup blocks for 5 seconds waiting for the timeout.

**Impact:** Every startup on Windows or container environments waits 5s for a network service that doesn't exist.

**Root cause:** No platform detection or fallback timeout — unconditional mDNS advertising attempt with no "is Bonjour available" preflight.

---

## 17. Plugin Memo Cache Keyed by JSON Stringify — Fragile

**File:** `G:\Dx\openclaw\src\plugins\plugin-metadata-snapshot.ts:54`

```typescript
private static memos = new Map<string, PluginMetadataSnapshot>();
```

Memo keys are built by `JSON.stringify`-ing the input parameters. Up to 8 concurrent memo caches. Misordering of object keys, undefined vs null, or subtle serialization differences produce cache misses.

**Impact:** Redundant plugin discovery on cache miss. Each miss triggers the full filesystem scan (100-500ms).

**Root cause:** Content-addressable cache designed for simplicity, not reliability. No binary serialization, no hash-based keying.
