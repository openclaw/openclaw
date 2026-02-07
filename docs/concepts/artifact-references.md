# Artifact References System

## Overview

The Artifact References system reduces token usage by storing large content externally and referencing it via compact IDs. Instead of repeatedly sending full files, code, or documents in every prompt, the system maintains a small **Hot State** JSON blob with an **Artifact Index** that references content in the **Artifact Store**.

## Architecture

```
┌───────────────────────────────┐
│         System Prompt         │
│                               │
│  ┌─────────────────────────┐  │
│  │      Hot State JSON     │  │  ← Always included, < 1KB
│  │  - session_id           │  │
│  │  - objective            │  │
│  │  - artifact_index: [    │  │
│  │    { id, type, label }  │  │  ← Compact references
│  │  ]                      │  │
│  └─────────────────────────┘  │
│                               │
│  ┌─────────────────────────┐  │
│  │  Bootstrap Context      │  │  ← Workspace files (inline or ArtifactRef)
│  │  (ArtifactRef: sha256)  │  │
│  └─────────────────────────┘  │
└───────────────────────────────┘
         │
         │ artifacts.get(id)
         ▼
┌───────────────────────────────┐
│       Artifact Store          │
│  file://<state_dir>/artifacts │
│                               │
│  Content-addressable (SHA256) │
│  Sharded by first 2 hex chars│
│  Size-capped (512KB default)  │
└───────────────────────────────┘
```

## Components

### Hot State (`src/agents/hot-state.ts`)

A small, structured JSON blob included in every dispatcher prompt. Maintained exclusively by the Dispatcher.

**Schema (Zod-validated):**

```typescript
{
  session_id: string      // required
  session_key?: string
  run_id?: string
  objective?: string
  current_plan_id?: string | null
  accepted_decisions?: string[]
  open_questions?: string[]
  constraints?: string[]
  last_successful_step?: string
  risk_level?: "low" | "medium" | "high"
  artifact_index?: ArtifactIndexEntry[]
}
```

**Constraints:**

- JSON only (no free-form prose)
- Schema-validated on every build
- Token-capped (≤ 1,000 tokens)
- Falls back to minimal state if budget exceeded

### Artifact Index Entry

Compact reference to an artifact in the store:

```typescript
{
  artifact_id: string   // SHA256 hex (64 chars)
  type: "repo" | "doc" | "code" | "log" | "data" | "plan" | "result"
  label?: string        // human-readable name
  version?: string      // version/hash prefix
  summary?: string      // 1-2 line description
}
```

### Artifact Record (`src/artifacts/artifact-record.ts`)

Full metadata schema for artifacts in the store:

```typescript
{
  artifact_id: string       // SHA256 hex
  type: ArtifactType        // semantic classification
  content_uri: string       // storage location (file:// / s3://)
  content_hash: string      // SHA256 integrity check
  size_bytes: number        // exact byte count
  created_at: string        // ISO timestamp
  producer?: "dispatcher" | "executor" | "planner" | "system"
  summary?: string          // max 500 chars
  mime?: string             // content type
}
```

### Artifact Registry (`src/artifacts/artifact-registry.ts`)

Content-addressable storage backend:

- **ID = SHA256**: same content → same ID (automatic deduplication)
- **Sharded**: stored in `<root>/<first-2-hex>/<sha256>/`
- **Size-capped**: 512KB default per artifact
- **Operations**: `storeText()`, `storeJson()`, `get(id)`

### `artifacts.get` Tool (`src/agents/tools/artifacts-get-tool.ts`)

Runtime tool available to the agent for on-demand artifact retrieval:

- Fetches artifact by SHA256 ID
- Returns metadata + bounded content (truncated at 8K chars)
- Validates IDs strictly (64-char lowercase hex only)

## Budget Enforcement (`src/agents/context-budget.ts`)

Hard limits to prevent prompt bloat regression:

| Budget                    | Default | Description                                   |
| ------------------------- | ------- | --------------------------------------------- |
| `maxHotStateTokens`       | 1,000   | Max tokens for hot state JSON                 |
| `maxArtifactIndexEntries` | 20      | Max artifact refs in hot state                |
| `maxPromptTokens`         | 8,000   | Max total estimated prompt tokens             |
| `maxRagChunks`            | 10      | Max RAG chunks per turn                       |
| `maxInlineArtifactChars`  | 2,000   | Max chars before artifact must be a reference |

**Fail-closed behavior:** If any budget check is ambiguous (e.g., token estimation fails), the budget is treated as violated. No silent truncation.

## Metrics & Observability (`src/agents/prompt-metrics.ts`)

Per-turn metrics captured for every model call:

```json
{
  "type": "prompt_metrics",
  "session": "session-id",
  "run": "run-id",
  "hs_tokens": 45,
  "hs_bytes": 182,
  "hs_truncated": false,
  "artifacts": 2,
  "artifact_types": ["code", "doc"],
  "sys_chars": 5200,
  "user_chars": 150,
  "est_tokens": 1398,
  "ref_files": 1,
  "budget_violations": 0,
  "budget_ok": true
}
```

**Regression detection:** Automatic warnings when:

- Hot state tokens > 800 (approaching 1,000 limit)
- Artifact index > 15 entries
- Estimated prompt tokens > 6,000
- Budget violations detected

## Bootstrap File ArtifactRefs

When `OPENCLAW_ARTIFACT_REFS=true`, large workspace bootstrap files (AGENTS.md, SOUL.md, etc.) are stored as artifacts rather than inlined. The prompt includes:

```
ArtifactRef: <sha256> (type=text/markdown, sha256=..., bytes=..., createdAt=...)

Summary (head/tail excerpt):
[first ~4000 chars of content]
```

This enables the agent to use `artifacts.get` to retrieve the full content on demand, rather than paying the token cost on every turn.

Configure with:

- `OPENCLAW_ARTIFACT_REFS=true` — enable artifact refs for bootstrap files
- `OPENCLAW_ARTIFACT_REFS_THRESHOLD_CHARS=8000` — minimum file size to trigger ref storage

## Invariants

1. **Dispatcher supremacy**: Only the Dispatcher writes hot state
2. **Structural enforcement**: All schemas validated with Zod (not by prompt)
3. **Fail closed**: Ambiguous budget checks → treated as violated
4. **No silent truncation**: Budget violations are logged and warned, never hidden
5. **Content-addressable**: Same content always produces the same artifact ID
