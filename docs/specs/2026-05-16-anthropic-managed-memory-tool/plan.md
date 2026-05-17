# Plan — Anthropic managed memory tool

## Approach

The Pi SDK already lets us inject Anthropic-specific extra params (see `src/agents/pi-embedded-runner/extra-params.ts` which already handles hardcoded `cache_control`). Add a `memory` tool entry to that extra-params layer when the resolved model is in the Opus 4.7+ family, then implement a local handler that fulfills the tool's commands against `~/.openclaw/agents/<agentId>/memories/` with a strict path-resolver. Surface the new tool to operators as part of the existing memory section in `openclaw configure`.

## Steps

1. Detect capability: extend `src/agents/model-catalog.ts` with a `supportsManagedMemoryTool` flag derived from model id (Opus 4.7+ on Anthropic; pass-through if a provider exposes a compatible primitive).
2. Implement `src/agents/tools/managed-memory-tool.ts` — handler for `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. Use `node:fs/promises`; resolve every path through a helper that rejects anything outside the per-agent root.
3. Add `src/agents/pi-embedded-runner/managed-memory.ts` — emit the Anthropic `memory` tool definition in extra-params when the capability flag is true and `memory.managed.enabled !== false`.
4. Add config keys: `memory.managed.enabled` (default `auto` — on when capability is present), `memory.managed.root` (override the default per-agent path). Hook into `src/config/`.
5. Audit log: every memory command writes a JSONL entry to `~/.openclaw/agents/<agentId>/memories/.audit.jsonl` so transcript replay can show what the model wrote.
6. Surface in the existing memory configure wizard step (`src/commands/configure.wizard.ts`) — describe the difference between custom search and managed scratchpad.
7. Tool-policy: add `managed_memory` to the allow/deny machinery in `src/agents/tool-policy.ts` so operators can disable per-agent.
8. Docs: extend `docs/concepts/memory.md` (or new sibling) explaining the two-layer model.

## Dependencies / order

- Step 1 blocks step 3.
- Steps 2 and 3 must land together (tool handler + extra-params injection).
- Steps 5–8 can land after the core ships.
