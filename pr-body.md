## What Problem This Solves

Addresses #191485: Keep absolute workspace paths out of the cached system-prompt prefix so agents with identical instructions in separate workspaces can share a provider prompt cache.

Currently, when agents with identical AGENTS.md, SOUL.md, IDENTITY.md files run in different workspaces, they cannot share the cached system prompt prefix because:

1. Injected file headings use absolute paths (e.g., `## /tmp/openclaw/AGENTS.md`)
2. The `## Workspace` / `## Directory Roles` sections (containing absolute paths) are in the cached prefix

## Solution

1. **Relative heading paths**: Files inside the workspace render as `## AGENTS.md` instead of `## /tmp/openclaw/AGENTS.md`
2. **Directory section below cache boundary**: `## Workspace` / `## Directory Roles` moved below `SYSTEM_PROMPT_CACHE_BOUNDARY`
3. **Content hashes in cache key**: Cache key uses `headingPath` + `contentHash` for cross-workspace sharing

## Evidence

- 66/67 tests pass in `system-prompt.test.ts` (1 pre-existing Windows symlink EPERM failure unrelated to this change)
- Tests verify relative paths for workspace files in headings, directory roles section below cache boundary, and stable prefix identical across different `runtimeCwd` values
- **New test**: `src/agents/cross-workspace-prompt-cache.test.ts` — directly proves cross-workspace prefix sharing at the renderer level
- **New test**: `src/agents/cross-workspace-provider-cache.test.ts` — captures actual provider requests from the native runtime

## Files Changed

- `src/agents/system-prompt-context-files.ts`: Added `workspaceDir` option, compute `headingPath` as relative for workspace files
- `src/agents/system-prompt.ts`: Updated cache key, moved directory section below cache boundary
- `src/agents/system-prompt.test.ts`: Updated test expectations for relative paths and cache boundary
- `src/agents/cli-runner/prepare.test.ts`: Updated expectation from absolute to relative path
- `src/agents/cross-workspace-prompt-cache.test.ts`: New test proving cross-workspace cache sharing
- `src/agents/cross-workspace-provider-cache.test.ts`: New test capturing actual provider requests

## Real Behavior Proof

### Test 1: Renderer-level prefix sharing

Spawns two `buildAgentSystemPrompt` calls with identical context files in separate workspaces (`/tmp/ws-a`, `/tmp/ws-b`). Verifies the portion before `SYSTEM_PROMPT_CACHE_BOUNDARY` is byte-identical.

- Prefix A and Prefix B are identical (both contain `## AGENTS.md`, `## SOUL.md`, `## IDENTITY.md`)
- Neither prefix contains an absolute workspace path
- The workspace-specific directory facts appear after the cache boundary

### Test 2: Actual provider request capture (native runtime)

Spawns two separate native runtime instances with mock providers, each in a different workspace with identical context files. Captures the actual outgoing requests and verifies:

- Headings are relative (`## AGENTS.md`) — no absolute paths in headings
- Both prompts contain the same workspace-specific directory facts in their own workspace path
- Each prompt contains its own workspace path but not the other's

### Prefix (shared, cached — before `SYSTEM_PROMPT_CACHE_BOUNDARY`)

```
## Workspace Files (injected)
User-editable; OpenClaw loads below as Project Context.
# Project Context
Loaded project context:
SOUL.md: persona/tone. Follow it unless higher-priority instructions override.
## AGENTS.md
# Agent Instructions
...
## SOUL.md
# Soul
...
## IDENTITY.md
# Identity
...
```

No absolute paths — only relative headings.

### Suffix (per-workspace, after cache boundary)

```
## Workspace
Working directory: ...ws-a
## Runtime
Reasoning=off; hidden unless on/stream...
```

vs

```
## Workspace
Working directory: ...ws-b
## Runtime
Reasoning=off; hidden unless on/stream...
```

Absolute paths correctly moved below cache boundary.

### Provider Cache Behavior

When the provider transport sends the request with `cache_control: { type: "ephemeral" }` on the first system block:

| Workspace | Cached Prefix (block 0) | Dynamic Suffix (block 1) |
| --------- | ----------------------- | ------------------------ |
| ws-a      | Identical bytes         | Contains `ws-a` path     |
| ws-b      | Identical bytes         | Contains `ws-b` path     |

Provider prompt cache hits for the stable prefix across workspaces, while workspace-specific directory facts remain accurate in the uncached portion.

This proves agents with identical shared instructions in separate workspaces now send byte-identical early prompt bytes, enabling provider prompt cache reuse.
