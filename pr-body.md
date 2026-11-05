## What Problem This Solves

Addresses #191485: Keep absolute workspace paths out of the cached system-prompt prefix so agents with the same instructions can share a prompt cache.

Currently, when agents with identical AGENTS.md, SOUL.md, IDENTITY.md files run in different workspaces, they cannot share the cached system prompt prefix because:

1. Injected file headings use absolute paths (e.g., `## /tmp/openclaw/AGENTS.md`)
2. The `## Workspace` / `## Directory Roles` sections (containing absolute paths) are in the cached prefix

## Solution

1. **Relative heading paths**: Files inside the workspace now render as `## AGENTS.md` instead of `## /tmp/openclaw/AGENTS.md`
2. **Directory section below cache boundary**: `## Workspace` / `## Directory Roles` moved below `SYSTEM_PROMPT_CACHE_BOUNDARY` next to `## Runtime`
3. **Content hashes in cache key**: Added `contentHash` to prevent cross-test cache collisions

## Evidence

- 66/67 tests pass in `system-prompt.test.ts` (1 pre-existing Windows symlink EPERM failure unrelated to this change)
- Tests verify:
  - Relative paths for workspace files in headings (`## BOOTSTRAP.md`)
  - Directory roles section is below cache boundary
  - Stable prefix is identical across different `runtimeCwd` values
  - Content hashes prevent cross-test cache collisions

## Files Changed

- `src/agents/system-prompt-context-files.ts`: Added `workspaceDir` option, compute `headingPath` as relative for workspace files
- `src/agents/system-prompt.ts`: Updated cache key, moved directory section below cache boundary
- `src/agents/system-prompt.test.ts`: Updated test expectations for relative paths and cache boundary
- `src/agents/cli-runner/prepare.test.ts`: Updated expectation from absolute to relative path
