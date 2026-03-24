# RFC: Hybrid Mem0 Memory Backend (Layer 1 Integration)

> **Status: Implemented** — feature branch `feature/hybrid-mem0-backend` (3 commits)

## 1. Summary

This RFC proposes the integration of [Mem0](https://github.com/mem0ai/mem0) as an optional memory backend for OpenClaw. Recognizing the importance of OpenClaw's local-first privacy guarantees, this feature is fundamentally designed as a **Hybrid Architecture**. The local `memory-core` (Markdown + LanceDB) remains the absolute source of truth, while Mem0 acts as an optional, federated "semantic overlay" to provide advanced functionality like automated entity extraction, deduplication, and lifecycle decay.

## 2. Motivation

OpenClaw's default memory (`memory-core`) uses plain-text Markdown logs (`YYYY-MM-DD.md` and `MEMORY.md`), indexed by LanceDB. While incredibly robust and fully private, it lacks native semantic self-organization. Daily logs grow indefinitely, and the agent must manually summarize them.

Mem0 handles self-updating memory, tracks entities, user preferences, and deduplicates automatically. However, completely replacing `memory-core` with Mem0 breaks the "local first" promise of OpenClaw and introduces a dependency on an external SaaS/local service.

**The Solution:** A hybrid approach.

- We retain the read/write durability of local Markdown.
- We gain the advanced semantic extraction of Mem0.

## 3. Architecture & Design

### 3.1 Unifying the Memory Plugin Interface

The memory configuration schema in `src/config/types.memory.ts` will be updated to include a `mem0` block:

```typescript
export type MemoryMem0Config = {
  enabled?: boolean;
  /** For local Docker: any non-empty string. Ignored by the OSS server. */
  apiKey?: SecretInput;
  /** Defaults to `http://localhost:8000/v1` (local Docker/OSS). Set to `https://api.mem0.ai/v1` for cloud. */
  baseUrl?: string;
  /** Fallback timeout in ms. Defaults to 3000. */
  fallbackTimeoutMs?: number;
};
```

### 3.2 Dual-Write Tooling (`memory_add`)

We are introducing a new unified tool called `memory_add`.
When the agent invokes `memory_add`:

1. **Local Write:** Dispatches a flush instruction to the local `memory-core` backend, ensuring the fact is permanently written to `memory/YYYY-MM-DD.md`.
2. **Remote Write:** Asynchronously fires a REST call to `api.mem0.ai/v1/memories` (or the self-hosted `baseUrl`).
   If the remote write fails, the error is quietly logged but does not disrupt the agent's turn, as the local write succeeds.

### 3.3 Federated Search (`memory_search`)

The existing `memory_search` tool will become federated. If `mem0.enabled` is true:

1. `Promise.all` fires two concurrent searches: local LanceDB and distant Mem0.
2. The results are merged. Mem0 results are explicitly labeled (e.g., `[Mem0 Semantic]`) allowing the LLM to differentiate between an exact markdown quote and a Mem0-synthesized fact.
3. **Fallback Policy:** If Mem0 exceeds `fallbackTimeoutMs` (e.g., 2000ms) or returns an HTTP error, the system gracefully degrades. It intercepts the exception and returns _only_ the LanceDB results. Silent failure is preferred over agent paralysis.

### 3.4 Data Isolation and Namespacing

Mem0 is a multi-tenant system. To prevent OpenClaw workspaces from bleeding together:

- Every Mem0 API call will map the OpenClaw `user_id` to the Mem0 `user_id`.
- Every Mem0 API call will map the OpenClaw `workspace_id` (or active agent ID) to the Mem0 `agent_id`.
  This ensures a strict boundary between work, personal, and separate channels.

## 4. Usage Examples

**Example: local Docker (default, no cloud dependency):**

```yaml
memory:
  mem0:
    enabled: true
    apiKey: local # any non-empty string, ignored by OSS server
    # baseUrl defaults to http://localhost:8000/v1
    fallbackTimeoutMs: 3000
```

**Example: Mem0 cloud:**

```yaml
memory:
  mem0:
    enabled: true
    apiKey:
      env: MEM0_API_KEY
    baseUrl: https://api.mem0.ai/v1
    fallbackTimeoutMs: 3000
```

**Agent Experience:**
User: "What's my favorite programming language?"
Agent calls `memory_search("favorite programming language")`.
Result returned to Agent:

```json
{
  "results": [
    {
      "path": "memory/2026-03-24.md#L45",
      "snippet": "- I prefer TypeScript for all strictly-typed projects.",
      "source": "memory-core"
    },
    {
      "snippet": "[Mem0 Semantic] User strongly prefers TypeScript over JavaScript.",
      "source": "mem0"
    }
  ]
}
```

## 5. Risks and Mitigations

| Risk                         | Mitigation                                                                                                                                                                                                                                                                                             |
| :--------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Privacy Leakage**          | Mem0 is strictly opt-in (`enabled: false` by default). Users must explicitly provide an API key. For ultimate privacy, users can point `baseUrl` to a local, open-source Mem0 docker container.                                                                                                        |
| **External Service Failure** | Federated search implies that a slow Mem0 API could block the agent. Mitigation: A hard-coded or user-configurable `fallbackTimeoutMs` ensures that search requests abort fast if the service is down, relying entirely on LanceDB.                                                                    |
| **Namespace Collision**      | Strict mapping of `user_id` -> Mem0 `user_id` prevents cross-pollution inside the Mem0 dataset.                                                                                                                                                                                                        |
| **Double-Entry Bloat**       | Since data is in LanceDB _and_ Mem0, the agent might see redundant facts. Mitigation: LLMs naturally handle duplicate context fairly well, but we can also implement rudimentary deduplication in the federated merger if the semantic distance between the LanceDB snippet and Mem0 snippet is < 0.1. |

## 6. Future Work (Layer 2)

_(Out of Scope for this RFC)_
Once the Layer 1 Hybrid Backend is stable, we plan to implement Layer 2 "Frontend Pipeline UX" features:

- **Proactive Zero-Shot RAG:** Intercepting user messages and injecting `memory_search` snippets directly into the `<Context>` prompt without manual tool calls.
- **Offline Consolidation:** A "Sleep Agent" that periodically squashes local Markdown daily logs into `MEMORY.md` to prevent local file bloat over months of usage.

## 7. Test Coverage

### `src/memory/mem0-client.test.ts` — REST client unit tests (7 tests)

| Test                                                | What is validated                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `adds a memory — uses localhost default URL`        | Default `baseUrl` is `http://localhost:8000/v1`, Authorization header set |
| `strips trailing slash from custom baseUrl`         | `http://host/v1/` → URL built without double slash                        |
| `throws on addMemory API failure`                   | 5xx responses are re-thrown as `Mem0 API Error [500]: …`                  |
| `searches memory and formats MemorySearchResult`    | All fields mapped: `path`, `snippet`, `score`, `citation`, `source`       |
| `returns empty array when search yields no results` | `[]` API response → `[]` returned, no crash                               |
| `throws standard error on search API failure`       | 401 responses re-thrown correctly                                         |
| `uses cloud API URL when explicitly set`            | `baseUrl: https://api.mem0.ai/v1` routes to cloud                         |

### `src/agents/tools/memory-tool.mem0.test.ts` — dual-write tool unit tests (5 tests)

| Test                                                  | What is validated                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `writes to both local Markdown and Mem0 when enabled` | `fs.appendFile` called + `Mem0Client.addMemory` fired, `federated: true`      |
| `only writes local if Mem0 is disabled`               | `addMemory` never called, `federated: false`                                  |
| `Mem0 write fails → local still succeeds`             | Exception in Mem0 is swallowed, `success: true`, `fs.appendFile` still called |
| `local FS write fails → returns error`                | `mkdir` EACCES → `{ success: false, error: … }`                               |
| `localPath follows YYYY-MM-DD.md format`              | Regex: `memory/\d{4}-\d{2}-\d{2}\.md`                                         |
