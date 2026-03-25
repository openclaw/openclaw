# agentMemo memorySearch Provider — Design Document

**Author:** Karl Yang (yxjsxy)  
**Date:** 2026-03-25  
**Status:** Draft / PR Ready  
**Linked project:** [agentMemo](https://github.com/yxjsxy/agentMemo)

---

## 1. Background & Motivation

OpenClaw's built-in `memorySearch` system embeds and indexes local Markdown files
using vector embeddings (OpenAI / Gemini / Voyage / Mistral / local). This works
well for single-agent personal deployments.

For multi-agent, multi-namespace, or production deployments, users benefit from
a **dedicated external memory service** that provides:

- **Hybrid search** (dense + sparse + temporal decay) without managing SQLite files
- **Version history** — every memory write is recorded with full provenance
- **Importance decay** — memories age and become less prominent over time
- **Multi-agent namespaces** — isolate memories by agent, project, or org
- **REST API** — accessible from any language, any runtime
- **Persistence across node restarts** without re-embedding

[agentMemo](https://github.com/yxjsxy/agentMemo) is a purpose-built, self-hostable
memory service that satisfies all these needs. This document describes how to
integrate it as a first-class `memorySearch` provider in OpenClaw.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────┐
│           OpenClaw Runtime              │
│                                         │
│  memory_search tool                     │
│       │                                 │
│       ▼                                 │
│  getMemorySearchManager()               │
│       │                                 │
│       ├─ provider = "agentmemo"  ──────────────► agentMemo HTTP Service
│       ├─ provider = "builtin"           │              │
│       └─ backend = "qmd"               │         localhost:8790
└─────────────────────────────────────────┘              │
                                                    ┌────┴────────┐
                                                    │  /search    │
                                                    │  /memories  │
                                                    │  /health    │
                                                    └─────────────┘
```

The integration is **thin adapter** pattern:

- OpenClaw delegates search to agentMemo via HTTP
- agentMemo handles all embedding, indexing, and storage
- No local SQLite / vector index needed on the OpenClaw side for this path

---

## 3. Configuration

### 3.1 Minimal Configuration

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

Uses defaults: `http://localhost:8790`, namespace `openclaw`.

### 3.2 Full Configuration

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "agentmemo",
        "agentmemo": {
          "url": "http://localhost:8790",
          "apiKey": "optional-bearer-token",
          "namespace": "openclaw"
        }
      }
    }
  }
}
```

### 3.3 Per-Agent Override

```json
{
  "agents": {
    "mybot": {
      "memorySearch": {
        "provider": "agentmemo",
        "agentmemo": {
          "url": "https://memo.mycompany.com",
          "apiKey": "secret:env:AGENTMEMO_KEY",
          "namespace": "mybot-prod"
        }
      }
    }
  }
}
```

---

## 4. Config Schema Changes

### 4.1 `src/config/types.tools.ts` — `MemorySearchConfig`

Add `"agentmemo"` to the provider union type and add `agentmemo` config block:

```typescript
// Before
provider?: "openai" | "gemini" | "local" | "voyage" | "mistral" | "ollama";

// After
provider?: "openai" | "gemini" | "local" | "voyage" | "mistral" | "ollama" | "agentmemo";

// New block (alongside remote, local, etc.)
agentmemo?: {
  /** Base URL of the agentMemo service (default: http://localhost:8790). */
  url?: string;
  /** Optional bearer token / API key. */
  apiKey?: string;
  /** Namespace for scoping memories (default: "openclaw"). */
  namespace?: string;
};
```

### 4.2 `src/agents/memory-search.ts` — `ResolvedMemorySearchConfig`

```typescript
// Before
provider: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama" | "auto";

// After
provider: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama" | "agentmemo" | "auto";

// New resolved field
agentmemo?: {
  url: string;
  apiKey?: string;
  namespace: string;
};
```

### 4.3 `src/memory/search-manager.ts` — `getMemorySearchManager()`

Add agentmemo branch before the QMD/builtin fallthrough:

```typescript
if (resolved.provider === "agentmemo") {
  const { createAgentMemoSearchManager } = await import("./providers/agentmemo.js");
  const manager = createAgentMemoSearchManager({
    url: resolved.agentmemo?.url,
    apiKey: resolved.agentmemo?.apiKey,
    namespace: resolved.agentmemo?.namespace,
  });
  return { manager };
}
```

---

## 5. API Mapping

| OpenClaw Operation     | agentMemo Endpoint   | Notes                                        |
| ---------------------- | -------------------- | -------------------------------------------- |
| `memory_search(query)` | `POST /search`       | Body: `{query, namespace, limit, min_score}` |
| `memory_get(path)`     | `GET /memories/{id}` | Path-encoded id                              |
| Health probe           | `GET /health`        | Used by `probeEmbeddingAvailability()`       |

### 5.1 `/search` Request / Response

**Request:**

```json
{
  "query": "how do I reset my password",
  "namespace": "openclaw",
  "limit": 6,
  "min_score": 0.35
}
```

**Response:**

```json
{
  "results": [
    {
      "id": "memory/MEMORY.md:42",
      "content": "Password reset via ...",
      "score": 0.87,
      "metadata": {
        "path": "memory/MEMORY.md",
        "start_line": 42,
        "end_line": 55,
        "source": "memory"
      }
    }
  ]
}
```

### 5.2 `/memories/{id}` Response

```json
{
  "id": "memory/MEMORY.md:42",
  "content": "Full content of the memory...",
  "metadata": { "path": "memory/MEMORY.md" }
}
```

---

## 6. New Files

| File                                | Description                                    |
| ----------------------------------- | ---------------------------------------------- |
| `src/memory/providers/agentmemo.ts` | `AgentMemoSearchManager` class (new, ~200 LOC) |
| `docs/agentmemo-provider-design.md` | This document                                  |
| `PR_DESCRIPTION.md`                 | PR description draft                           |

---

## 7. Modified Files (to complete implementation)

| File                                      | Change                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `src/config/types.tools.ts`               | Add `"agentmemo"` to `provider` union + `agentmemo?: {...}` config block |
| `src/agents/memory-search.ts`             | Resolve `agentmemo` config, add to `provider` union type                 |
| `src/memory/search-manager.ts`            | Add `agentmemo` branch in `getMemorySearchManager()`                     |
| `src/config/zod-schema.agent-defaults.ts` | Extend Zod schema for `agentmemo` provider                               |
| `src/secrets/target-registry-data.ts`     | Register `agentmemo.apiKey` as a secret target                           |

---

## 8. Testing Plan

1. **Unit tests** (`src/memory/providers/agentmemo.test.ts`)
   - Mock HTTP responses for `/search`, `/memories/{id}`, `/health`
   - Verify result mapping (score, snippet, path, source, citation)
   - Test error handling (404, 500, network error)
   - Test namespace isolation
   - Test optional apiKey (with / without Authorization header)

2. **Integration test** (requires running agentMemo)
   - `TEST_AGENTMEMO_URL=http://localhost:8790 pnpm test agentmemo`

3. **Config validation tests**
   - `provider = "agentmemo"` passes schema validation
   - `agentmemo.url` is optional (defaults to localhost:8790)
   - `agentmemo.apiKey` resolves secret refs

---

## 9. Security Considerations

- **SSRF protection**: Uses existing `buildRemoteBaseUrlPolicy()` + `withRemoteHttpResponse()` — same guards as OpenAI/Gemini remote embeddings
- **API key**: Transmitted as `Authorization: Bearer <key>` header; never logged
- **Secret refs**: `agentmemo.apiKey` should support `secret:env:VAR` syntax via existing secret resolver
- **Localhost default**: Default URL is `http://localhost:8790` — only reachable locally unless user explicitly configures a remote URL

---

## 10. Open Questions

1. Should agentMemo also support **push** (sync/write) from OpenClaw, or only pull (search/read)?
   - Current scope: **read-only** (search + readFile). Write path stays with agentMemo's own ingestion.
2. Should `sync()` be implemented to trigger agentMemo re-indexing via e.g. `POST /sync`?
   - Nice-to-have; not in initial PR.
3. Config field name: `agentmemo` vs `agent_memo` vs `agentMemo`?
   - Recommend: `agentmemo` (lowercase, consistent with provider id).
