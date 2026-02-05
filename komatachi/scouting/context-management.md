# Context Management - Scouting Report

## Summary

The Context Management component handles how AI/LLM conversation context is managed, including:

1. **Context Window Management**: Tracking and enforcing context window token limits for different models
2. **Compaction/Summarization**: Automatically summarizing older conversation history when context limits are approached, to maintain conversation continuity while staying within token limits
3. **Context Pruning**: Real-time pruning of tool results and other context elements to reduce token usage without full compaction
4. **History Limiting**: Limiting conversation history turns for DM sessions to manage memory/token usage
5. **Error Handling**: Detecting and handling context overflow errors from LLM providers

The component integrates with the Pi coding agent framework and provides extensions that hook into the agent session lifecycle to automatically manage context size.

## File Index

Key source files organized by distillation target. Cross-references to ROADMAP.md phases.
See detailed table below for complete listing with line counts and test files.

### Compaction (-> already distilled: src/compaction/)
src/agents/compaction.ts                - Core compaction: token estimation, chunking, multi-stage summarization
src/agents/pi-embedded-runner/compact.ts - Session compaction orchestration: when/how to trigger compaction
src/agents/pi-extensions/compaction-safeguard.ts - Compaction safeguard: tool failure extraction, file ops tracking

### Context window management (-> Phase 2.1: Context Window)
src/agents/context.ts                   - Context window token limits lookup from model registry
src/agents/context-window-guard.ts      - Validate message fits within context window; guard against overflow
src/agents/pi-embedded-runner/history.ts - DM history turn limiting (max turns, per-session config)
src/auto-reply/reply/history.ts         - Group chat history management with LRU eviction

### Context pruning (-> Phase 2.1: Context Window, pruning policy)
src/agents/pi-extensions/context-pruning/pruner.ts - Core pruning: soft trim (head/tail preservation) and hard clear
src/agents/pi-extensions/context-pruning/settings.ts - Pruning configuration: TTL, ratios, tool patterns, thresholds
src/agents/pi-extensions/context-pruning/tools.ts - Tool matching predicates for selective pruning
src/agents/pi-extensions/context-pruning/runtime.ts - Session-scoped pruning state registry (WeakMap-based)
src/agents/pi-extensions/context-pruning/extension.ts - Pi extension wiring for pruning events

### Error classification (reference)
src/agents/pi-embedded-helpers/errors.ts - Error classification: context overflow, rate limit, billing, auth
src/agents/pi-extensions/compaction-safeguard-runtime.ts - Runtime state for compaction safeguard

### Out of scope (extension wiring)
src/agents/pi-extensions/context-pruning.ts - Module entry point (re-export only)

## Source Files

| File | Lines | Description |
|------|-------|-------------|
| `/home/user/Komatachi/src/agents/context.ts` | 38 | Context window token lookup from model registry |
| `/home/user/Komatachi/src/agents/context-window-guard.ts` | 68 | Context window size validation and guards |
| `/home/user/Komatachi/src/agents/compaction.ts` | 345 | Core compaction/summarization logic (token estimation, chunking, multi-stage summarization) |
| `/home/user/Komatachi/src/agents/pi-extensions/context-pruning.ts` | 19 | Context pruning module entry point |
| `/home/user/Komatachi/src/agents/pi-extensions/context-pruning/extension.ts` | 39 | Pi extension for context pruning events |
| `/home/user/Komatachi/src/agents/pi-extensions/context-pruning/pruner.ts` | 283 | Core pruning logic (soft trim, hard clear) |
| `/home/user/Komatachi/src/agents/pi-extensions/context-pruning/runtime.ts` | 40 | Session-scoped runtime registry for pruning state |
| `/home/user/Komatachi/src/agents/pi-extensions/context-pruning/settings.ts` | 119 | Pruning configuration and defaults |
| `/home/user/Komatachi/src/agents/pi-extensions/context-pruning/tools.ts` | 53 | Tool matching predicates for pruning |
| `/home/user/Komatachi/src/agents/pi-extensions/compaction-safeguard.ts` | 321 | Compaction safeguard extension with fallback handling |
| `/home/user/Komatachi/src/agents/pi-extensions/compaction-safeguard-runtime.ts` | 34 | Runtime registry for compaction safeguard state |
| `/home/user/Komatachi/src/agents/pi-embedded-runner/history.ts` | 85 | DM history turn limiting |
| `/home/user/Komatachi/src/agents/pi-embedded-runner/compact.ts` | 497 | Session compaction execution orchestration |
| `/home/user/Komatachi/src/agents/pi-embedded-helpers/errors.ts` | 518 | Error classification including context overflow detection |
| `/home/user/Komatachi/src/auto-reply/reply/history.ts` | 171 | Group chat history management with LRU eviction |

## Total Lines of Code

**2,630 lines** across 15 source files

## Test Files

| Test File | Lines |
|-----------|-------|
| `/home/user/Komatachi/src/agents/context-window-guard.test.ts` | 135 |
| `/home/user/Komatachi/src/agents/compaction.test.ts` | 149 |
| `/home/user/Komatachi/src/agents/pi-extensions/context-pruning.test.ts` | 511 |
| `/home/user/Komatachi/src/agents/pi-extensions/compaction-safeguard.test.ts` | 252 |
| `/home/user/Komatachi/src/agents/pi-embedded-helpers.iscontextoverflowerror.test.ts` | 49 |
| `/home/user/Komatachi/src/agents/pi-embedded-helpers.islikelycontextoverflowerror.test.ts` | 34 |
| `/home/user/Komatachi/src/agents/pi-embedded-helpers.iscompactionfailureerror.test.ts` | 27 |
| `/home/user/Komatachi/src/agents/pi-embedded-runner/run.overflow-compaction.test.ts` | 285 |
| `/home/user/Komatachi/src/agents/pi-embedded-runner.limithistoryturns.test.ts` | 160 |
| `/home/user/Komatachi/src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.falls-back-provider-default-per-dm-not.test.ts` | 154 |
| `/home/user/Komatachi/src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.returns-undefined-sessionkey-is-undefined.test.ts` | 229 |
| `/home/user/Komatachi/src/agents/pi-embedded-runner.sanitize-session-history.test.ts` | 252 |
| `/home/user/Komatachi/src/auto-reply/reply/history.test.ts` | 152 |

**Total test lines: 2,389 lines across 13 test files**

## Complexity Assessment

**Complexity: HIGH**

### Reasoning

1. **Multiple interacting subsystems**: The component spans context window guards, compaction/summarization, pruning, and history management, all working together to manage context limits.

2. **Complex algorithms**:
   - Multi-stage summarization with fallback strategies for oversized messages
   - Adaptive chunk ratio calculation based on message sizes
   - Token estimation across different message types (user, assistant, tool results)
   - Progressive pruning with soft trim (head/tail preservation) and hard clear phases

3. **State management**: Uses WeakMap-based session-scoped registries to track pruning and compaction state across the session lifecycle.

4. **Error handling complexity**: Extensive error classification logic to detect various types of context overflow errors from different LLM providers (Anthropic, OpenAI, Google, etc.).

5. **Integration points**: Hooks into the Pi coding agent extension system via `context` and `session_before_compact` events, requiring careful coordination with the agent runtime.

6. **Edge cases**: Handles many edge cases including:
   - Tool results with images (exempt from pruning)
   - Bootstrap context protection (never prune before first user message)
   - Split turn handling during compaction
   - Tool failure preservation in summaries
   - LRU eviction for group history maps

7. **Configuration complexity**: Multiple configurable parameters for pruning behavior (TTL, ratios, tool allow/deny patterns, head/tail chars, etc.).

## Estimated Tests Required

For comprehensive coverage of this component, an estimated **80-100 tests** would be needed:

### Current Coverage (approximately 50 tests based on describe/it blocks)
- Context window guard: ~8 tests
- Compaction splitting/pruning: ~6 tests
- Context pruning extension: ~12 tests
- Compaction safeguard: ~8 tests
- Error classification: ~8 tests
- History limiting: ~8 tests

### Additional Tests Needed (~30-50 more tests)

1. **Compaction module (15-20 tests)**
   - `chunkMessagesByMaxTokens` edge cases
   - `computeAdaptiveChunkRatio` boundary conditions
   - `isOversizedForSummary` threshold tests
   - `summarizeWithFallback` error paths
   - `summarizeInStages` with various part counts

2. **Context pruning tools matching (5-8 tests)**
   - Wildcard pattern matching edge cases
   - Allow/deny precedence combinations
   - Case sensitivity handling

3. **Compaction safeguard (8-10 tests)**
   - Tool failure collection and formatting
   - File operations tracking
   - Split turn handling
   - API key resolution failures

4. **Error handling (5-8 tests)**
   - Additional provider-specific error patterns
   - `parseApiErrorInfo` edge cases
   - Rate limit vs billing vs auth error classification

5. **History management (5-8 tests)**
   - LRU eviction behavior
   - Concurrent history key access
   - Thread suffix stripping

**Estimated total tests for good coverage: 80-100 tests**
