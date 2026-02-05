# Session Management Component Scouting Report

## Summary

The session management component is responsible for managing conversational agent sessions, including session creation, lifecycle management, persistence, state tracking, and history/transcript logging. This is a core architectural component that supports:

- **Session Creation and Lifecycle**: Creating new sessions, handling session resets (via triggers like `/new`), managing session freshness based on daily or idle timeout policies
- **Session Persistence/Storage**: Storing session entries in JSON stores (`sessions.json`), managing session transcripts in JSONL files, implementing file locking for concurrent access
- **Session State Management**: Tracking session metadata (model overrides, thinking levels, queue settings, usage tokens, group metadata, delivery context)
- **Session Logs and History**: Appending messages to session transcripts, tracking tool calls and results, repairing transcript integrity
- **Session Recovery/Resumption**: Handling session freshness evaluation, supporting branched sessions from parent sessions, managing session compaction
- **Multi-session Handling**: Per-sender vs global sessions, group/channel sessions, thread sessions, cross-agent session access
- **Session Configuration**: Zod schema validation for session config, reset policies by type/channel, send policies, DM scope settings
- **Session Identifiers/IDs**: Agent-prefixed session keys (`agent:main:...`), session UUIDs, group/channel key resolution

## File Index

Key source files organized by distillation target. Cross-references to ROADMAP.md phases.
See detailed tables below for complete listings including line counts and test files.

### Storage primitives (-> Phase 1.1: Storage)
src/config/sessions/store.ts            - Session CRUD: load, save, atomic update with file locking and caching
src/config/sessions/transcript.ts       - JSONL transcript: append messages, read full/range, integrity checks
src/config/sessions/paths.ts            - Deterministic file path resolution from session/agent IDs
src/agents/session-write-lock.ts        - Advisory file locking: acquire, release, stale lock detection, process cleanup

### Session lifecycle (-> Phase 1.2: Session Store, Phase 1.3: Session State)
src/config/sessions/types.ts            - SessionEntry type definition; entry merge/normalization utilities
src/config/sessions/reset.ts            - Reset policies (daily/idle timeout); freshness evaluation logic
src/config/sessions/metadata.ts         - Derive session origin (channel, platform) and group metadata
src/config/sessions/main-session.ts     - Resolve the "main" session key for a given agent
src/config/sessions/session-key.ts      - Derive session key from routing context (sender, channel, thread)
src/auto-reply/reply/session.ts         - Session state initialization when an inbound message arrives
src/auto-reply/reply/session-updates.ts - Prepend system events, manage skill snapshots, trigger compaction
src/agents/session-transcript-repair.ts - Repair broken tool-use/tool-result pairing in transcripts
src/agents/session-slug.ts              - Generate human-readable session slugs from content

### Routing (-> Phase 4: Routing Stub)
src/routing/session-key.ts              - Build agent-prefixed session keys; normalize; resolve peer DM keys
src/config/sessions/group.ts            - Resolve group/channel session keys; build display names
src/sessions/session-key-utils.ts       - Parse session key format (extract agent, channel, sender)

### Configuration (reference)
src/config/zod-schema.session.ts        - Zod validation schema for session configuration
src/sessions/send-policy.ts             - Resolve who can send messages to a session
src/sessions/model-overrides.ts         - Apply model overrides to session entries
src/auto-reply/reply/session-reset-model.ts - Parse model override from reset command

### Out of scope (multi-agent, platform-specific, UI)
src/agents/tools/session-status-tool.ts - Agent tool: display session status (multi-agent)
src/agents/tools/sessions-send-tool.ts  - Agent tool: send to other sessions (multi-agent)
src/agents/tools/sessions-spawn-tool.ts - Agent tool: spawn sub-agent sessions (multi-agent)
src/agents/tools/sessions-list-tool.ts  - Agent tool: list sessions (multi-agent)
src/agents/tools/sessions-history-tool.ts - Agent tool: retrieve session history (multi-agent)
src/agents/tools/sessions-send-tool.a2a.ts - Agent-to-agent session sending (cross-agent)
src/web/session.ts                      - Web platform session management
src/tui/tui-session-actions.ts          - Terminal UI session actions
src/commands/sessions.ts                - CLI sessions command

## Source Files

### Core Session Store and Types (`src/config/sessions/`)
| File | Lines | Description |
|------|-------|-------------|
| `store.ts` | 440 | Session store CRUD operations with file locking and caching |
| `types.ts` | 167 | SessionEntry type definition and merge utilities |
| `reset.ts` | 142 | Session reset policies (daily/idle), freshness evaluation |
| `transcript.ts` | 133 | Transcript file management, message appending |
| `metadata.ts` | 122 | Session origin and group metadata derivation |
| `group.ts` | 100 | Group session key resolution and display name building |
| `paths.ts` | 73 | Session file path resolution |
| `main-session.ts` | 69 | Main session key resolution |
| `session-key.ts` | 37 | Session key derivation from context |
| **Subtotal** | **1,283** | |

### Session Utilities (`src/sessions/`)
| File | Lines | Description |
|------|-------|-------------|
| `send-policy.ts` | 78 | Session send policy resolution |
| `model-overrides.ts` | 72 | Model override application to session entries |
| `session-key-utils.ts` | 53 | Session key parsing utilities |
| `level-overrides.ts` | 26 | Verbose level override handling |
| `transcript-events.ts` | 23 | Session transcript update event emitter |
| `session-label.ts` | 18 | Session label parsing |
| **Subtotal** | **270** | |

### Session Configuration (`src/config/`)
| File | Lines | Description |
|------|-------|-------------|
| `zod-schema.session.ts` | 118 | Zod schema for session configuration |
| `sessions.ts` | 9 | Re-export barrel file |
| **Subtotal** | **127** | |

### Routing (`src/routing/`)
| File | Lines | Description |
|------|-------|-------------|
| `session-key.ts` | 217 | Agent session key building, normalization, peer resolution |
| **Subtotal** | **217** | |

### Auto-reply Session (`src/auto-reply/reply/`)
| File | Lines | Description |
|------|-------|-------------|
| `session.ts` | 376 | Session state initialization for inbound messages |
| `session-updates.ts` | 284 | System events prepending, skill snapshot management, compaction |
| `session-reset-model.ts` | 178 | Model override parsing on session reset |
| `session-usage.ts` | 94 | Session usage persistence |
| **Subtotal** | **932** | |

### Agent Session Management (`src/agents/`)
| File | Lines | Description |
|------|-------|-------------|
| `session-transcript-repair.ts` | 206 | Tool use/result pairing repair in transcripts |
| `session-write-lock.ts` | 188 | Session file write locking with process cleanup |
| `session-tool-result-guard.ts` | 144 | Tool result persistence guard |
| `session-slug.ts` | 133 | Session slug generation |
| `session-tool-result-guard-wrapper.ts` | 54 | Tool result guard wrapper |
| `cli-session.ts` | 29 | CLI session ID management |
| **Subtotal** | **754** | |

### Agent Session Manager (`src/agents/pi-embedded-runner/`)
| File | Lines | Description |
|------|-------|-------------|
| `session-manager-cache.ts` | 60 | Session manager caching and prewarming |
| `session-manager-init.ts` | 53 | Session manager initialization quirk handling |
| **Subtotal** | **113** | |

### Agent Tools - Sessions (`src/agents/tools/`)
| File | Lines | Description |
|------|-------|-------------|
| `session-status-tool.ts` | 452 | Session status display tool |
| `sessions-send-tool.ts` | 392 | Session message sending tool |
| `sessions-helpers.ts` | 327 | Shared session tool utilities |
| `sessions-spawn-tool.ts` | 269 | Subagent session spawning tool |
| `sessions-list-tool.ts` | 208 | Session listing tool |
| `sessions-send-helpers.ts` | 154 | Session send helper utilities |
| `sessions-history-tool.ts` | 141 | Session history retrieval tool |
| `sessions-send-tool.a2a.ts` | 141 | Agent-to-agent session sending |
| `sessions-announce-target.ts` | 55 | Session announce target resolution |
| **Subtotal** | **2,139** | |

### Channel Session (`src/channels/`)
| File | Lines | Description |
|------|-------|-------------|
| `session.ts` | 49 | Inbound session recording |
| **Subtotal** | **49** | |

### Web/ACP/Cron Session
| File | Lines | Description |
|------|-------|-------------|
| `src/web/session.ts` | 285 | Web session management |
| `src/acp/session-mapper.ts` | 91 | ACP session mapping |
| `src/acp/session.ts` | 85 | ACP session utilities |
| `src/web/auto-reply/session-snapshot.ts` | 69 | Web session snapshot |
| `src/cron/isolated-agent/session.ts` | 35 | Cron isolated agent session |
| **Subtotal** | **565** | |

### Memory/TUI/Commands
| File | Lines | Description |
|------|-------|-------------|
| `src/tui/tui-session-actions.ts` | 246 | TUI session action handlers |
| `src/commands/sessions.ts` | 249 | CLI sessions command |
| `src/agents/auth-profiles/session-override.ts` | 139 | Auth profile session override |
| `src/memory/sync-session-files.ts` | 130 | Session file syncing |
| `src/memory/session-files.ts` | 106 | Session file utilities |
| **Subtotal** | **870** | |

## Total Lines of Code

| Category | Lines |
|----------|-------|
| Core Session Store/Types | 1,283 |
| Session Utilities | 270 |
| Session Configuration | 127 |
| Routing | 217 |
| Auto-reply Session | 932 |
| Agent Session Management | 754 |
| Agent Session Manager | 113 |
| Agent Tools - Sessions | 2,139 |
| Channel Session | 49 |
| Web/ACP/Cron Session | 565 |
| Memory/TUI/Commands | 870 |
| **Total Source Lines** | **7,319** |

## Existing Test Files

| Test File | Lines |
|-----------|-------|
| `src/auto-reply/reply/session.test.ts` | 477 |
| `src/config/sessions.test.ts` | 457 |
| `src/auto-reply/reply/session-resets.test.ts` | 379 |
| `src/web/session.test.ts` | 230 |
| `src/config/sessions.cache.test.ts` | 213 |
| `src/agents/session-write-lock.test.ts` | 162 |
| `src/agents/session-tool-result-guard.test.ts` | 145 |
| `src/agents/session-tool-result-guard.tool-result-persist-hook.test.ts` | 143 |
| `src/config/sessions/transcript.test.ts` | 114 |
| `src/agents/session-transcript-repair.test.ts` | 112 |
| `src/sessions/send-policy.test.ts` | 58 |
| `src/agents/session-slug.test.ts` | 26 |
| `src/config/sessions/metadata.test.ts` | 23 |
| **Core Session Test Total** | **2,539** |

Additional session-related test files exist across the codebase (55 total files with "session" in the name, totaling ~9,269 lines), but many focus on integration testing for features that use sessions rather than testing the session management core.

**Number of Existing Core Test Files**: 13

## Complexity Assessment: HIGH

### Reasoning:

1. **Large Surface Area**: Over 7,300 lines of code across 35+ source files spanning multiple subsystems (config, agents, auto-reply, web, CLI, tools).

2. **Concurrent Access Patterns**: File-based locking mechanisms for session stores and transcript files (`session-write-lock.ts`, `store.ts`), with cross-process coordination and stale lock detection.

3. **Complex State Management**: Session entries track 50+ fields including model overrides, auth profiles, usage tokens, delivery context, queue settings, group metadata, and skill snapshots.

4. **Multi-layered Session Key Resolution**: Agent-prefixed keys, group/channel keys, thread keys, peer DM keys, identity linking, and session ID to key resolution.

5. **Session Lifecycle Complexity**: Daily and idle reset policies, per-type/per-channel reset configurations, session freshness evaluation, compaction state tracking.

6. **Transcript Repair**: Tool use/result pairing validation and repair to handle corrupted or malformed session histories.

7. **Cross-Agent Access Control**: Agent-to-agent session access policies with allowlists and session scope validation.

8. **Caching Layers**: Session store cache with TTL, session manager cache for prewarming, mtime-based invalidation.

9. **Integration Points**: Sessions integrate with auth profiles, model selection, usage tracking, message delivery, queuing, group chat handling, and the TUI/CLI.

## Estimated Tests Required for Good Coverage

### Unit Tests (Granular function/module testing)

| Area | Estimated Tests |
|------|-----------------|
| Session store CRUD (load, save, update, locking) | 20-25 |
| Session entry merging and normalization | 10-15 |
| Session key resolution (all formats) | 15-20 |
| Session reset policies (daily, idle, per-type, per-channel) | 15-20 |
| Session freshness evaluation | 10-12 |
| Transcript operations | 12-15 |
| Metadata derivation (origin, group) | 10-12 |
| Model/auth profile overrides | 10-12 |
| Send policy resolution | 8-10 |
| Session write locking | 12-15 |
| Transcript repair | 15-18 |
| Session tools (status, send, spawn, list, history) | 30-40 |
| Session key utilities | 8-10 |
| CLI session management | 6-8 |
| Web session management | 12-15 |
| **Unit Test Subtotal** | **183-227** |

### Integration Tests

| Area | Estimated Tests |
|------|-----------------|
| Session lifecycle (create, reset, resume) | 10-15 |
| Concurrent session access | 8-10 |
| Cross-agent session access | 8-10 |
| Session + message delivery flow | 10-12 |
| Session + model switching | 6-8 |
| Group/thread session handling | 10-12 |
| Session compaction integration | 6-8 |
| **Integration Test Subtotal** | **58-75** |

### Edge Case and Error Handling Tests

| Area | Estimated Tests |
|------|-----------------|
| Corrupted session stores | 5-8 |
| Lock timeouts and stale locks | 6-8 |
| Invalid session keys | 5-8 |
| Missing files/directories | 5-6 |
| Malformed transcripts | 8-10 |
| Race conditions | 5-8 |
| **Edge Case Subtotal** | **34-48** |

### Total Estimated Tests: 275-350

Current coverage is approximately 50-60% based on existing tests. To achieve comprehensive coverage (90%+), an additional **150-200 tests** would be needed, focusing on:
- Session reset edge cases
- Concurrent access scenarios
- Cross-agent session policies
- Transcript repair edge cases
- Session tools comprehensive testing
- Error handling and recovery paths
