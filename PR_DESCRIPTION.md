# feat: add agentMemo as memorySearch provider

## Summary

Adds `agentmemo` as a new `memorySearch` provider option in OpenClaw, enabling users
to delegate all semantic memory search to an external [agentMemo](https://github.com/yxjsxy/agentMemo)
HTTP service instead of managing a local SQLite/vector index.

---

## Motivation

OpenClaw's built-in memorySearch (`local`, `openai`, `gemini`, etc.) works great for
single-user deployments that keep Markdown notes in a workspace. However, larger or
multi-agent deployments benefit from a **dedicated, self-hosted memory service** with:

| Need | Built-in | agentMemo |
|---|---|---|
| Hybrid search (dense + sparse) | ✅ | ✅ (with temporal decay) |
| Version history per memory | ❌ | ✅ |
| Importance decay over time | ❌ | ✅ |
| Multi-agent namespace isolation | Manual paths | First-class namespaces |
| No local re-embedding on restart | SQLite persists | HTTP stateless |
| Multi-language / multi-runtime | Node.js only | REST API |

---

## What's Changed

### New Files

- **`src/memory/providers/agentmemo.ts`** — `AgentMemoSearchManager` class that
  implements the `MemorySearchManager` interface by forwarding calls to the agentMemo
  HTTP service. Uses the existing `withRemoteHttpResponse()` + SSRF-guard infrastructure.

- **`docs/agentmemo-provider-design.md`** — Full design document covering API mapping,
  config schema changes, security considerations, and testing plan.

### Planned Changes (schema + wiring, not yet applied)

The following changes are needed to wire the provider into the config system:

1. **`src/config/types.tools.ts`**: Add `"agentmemo"` to `MemorySearchConfig.provider` union
   and add `agentmemo?: { url?, apiKey?, namespace? }` config block.

2. **`src/agents/memory-search.ts`**: Resolve `agentmemo` config block into
   `ResolvedMemorySearchConfig`; add `"agentmemo"` to the `provider` type.

3. **`src/memory/search-manager.ts`**: Add `agentmemo` branch in `getMemorySearchManager()`
   before QMD/builtin fallthrough.

4. **`src/config/zod-schema.agent-defaults.ts`**: Extend Zod schema for `agentmemo` provider.

5. **`src/secrets/target-registry-data.ts`**: Register `agentmemo.apiKey` as a secret target
   (supports `secret:env:VAR` syntax).

> **Note:** The design doc + provider implementation are complete and ready for review.
> Schema/wiring changes can be landed in this PR or a follow-up at maintainer discretion.

---

## Configuration

### Minimal

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "agentmemo"
      }
    }
  }
}
```

### Full

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "agentmemo",
        "agentmemo": {
          "url": "http://localhost:8790",
          "apiKey": "secret:env:AGENTMEMO_KEY",
          "namespace": "openclaw"
        }
      }
    }
  }
}
```

---

## agentMemo API Mapping

| OpenClaw Operation | agentMemo Endpoint | Method |
|---|---|---|
| `memory_search(query)` | `/search` | POST |
| `memory_get(path)` | `/memories/{id}` | GET |
| `probeEmbeddingAvailability()` | `/health` | GET |

---

## Testing Plan

- [ ] Unit tests with mocked HTTP (`src/memory/providers/agentmemo.test.ts`)
  - Search response mapping (score, snippet, path, citation)
  - ReadFile path encoding + line slicing
  - Error handling (404, 500, network)
  - Auth header injection (with/without apiKey)
  - Namespace isolation in request body
- [ ] Config schema validation tests
  - `provider = "agentmemo"` accepted
  - `agentmemo.url` defaults correctly
  - `agentmemo.apiKey` resolves secret refs
- [ ] Integration test (optional, requires running agentMemo)

---

## Security

- Uses existing `buildRemoteBaseUrlPolicy()` + `fetchWithSsrFGuard()` — same SSRF
  protection as OpenAI/Gemini remote embedding endpoints.
- `apiKey` transmitted as `Authorization: Bearer` header only; never logged.
- Default URL is `http://localhost:8790` — only locally reachable unless explicitly configured.

---

## Links

- agentMemo project: https://github.com/yxjsxy/agentMemo
- Design doc: [`docs/agentmemo-provider-design.md`](./docs/agentmemo-provider-design.md)
- Provider implementation: [`src/memory/providers/agentmemo.ts`](./src/memory/providers/agentmemo.ts)

---

## Checklist

- [x] New provider implementation follows `MemorySearchManager` interface
- [x] SSRF guard used (consistent with existing remote providers)
- [x] Design doc written
- [x] PR description complete
- [ ] Config schema extended (`types.tools.ts`, Zod schema)
- [ ] Provider wired into `getMemorySearchManager()`
- [ ] Unit tests passing
- [ ] `pnpm build` passes
