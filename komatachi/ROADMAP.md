# Distillation Roadmap

This document is a contract between the human and Claude for autonomous execution of the Komatachi distillation. It defines what will be built, in what order, and how decisions are made.

> **Context**: Komatachi is an agentic LLM loop with self-awareness and long-term persistence, built for persistent AI entities with identity, memory, and continuity. OpenClaw provides useful primitives, but Komatachi's purpose is fundamentally different. Every module below serves this vision -- "system prompt" is the agent's sense of self, "conversation store" is the agent's memory, "tool policy" is what the agent can do in the world. See [DISTILLATION.md](./DISTILLATION.md) for the full framing.

---

## Why Autonomous Execution

The distillation process follows a repeatable cycle: Study the scouting report, design the interface, build the implementation, validate with tests, document decisions. Each cycle produces a self-contained module with clear inputs, outputs, and acceptance criteria.

This repeatability means Claude can execute the cycle independently for each module, provided two conditions are met:

1. **Agreement on what to build** -- A sequenced roadmap with scope boundaries, so Claude works on the right thing in the right order.
2. **Agreement on how to decide** -- Pre-resolved decision points and clear authority boundaries, so Claude doesn't drift on ambiguous calls.

The roadmap below satisfies condition 1. The Decision Authority section satisfies condition 2.

### How We Ensured Effectiveness

The roadmap was developed collaboratively in a single session. The process:

1. **Surveyed remaining work** -- Enumerated all un-distilled modules from the four scouting reports (~20k LOC across context management, memory/search, agent alignment, session management).
2. **Identified dependencies** -- Mapped which modules depend on which, producing a partial order.
3. **Applied scope reduction** -- Deferred everything not needed for a minimal viable single-agent, single-session system. This eliminated vector search, file sync, memory orchestration, cross-agent access, and multi-agent routing.
4. **Pre-resolved decision points** -- Walked through each phase and made architectural calls upfront rather than leaving them for Claude to encounter mid-implementation.
5. **Documented reasoning** -- Every deferral and decision includes its rationale, so future sessions can understand *why* without re-deriving it.

The safety net: each completed module is committed and available for human review before dependent modules are built. If drift occurs, it surfaces at module boundaries -- not after the entire system is built.

---

## Session Protocol

Each autonomous session follows this protocol:

1. **Read PROGRESS.md** -- Orient to current state.
2. **Identify the next roadmap item** -- Pick the next incomplete phase/module.
3. **Execute the distillation cycle**:
   - Study the scouting report for relevant sections
   - Design the interface (types, function signatures, error cases)
   - Build the implementation
   - Write tests (following `docs/testing-strategy.md`)
   - Write DECISIONS.md for the module
4. **Update PROGRESS.md** -- Record what was completed, any insights discovered, any new open questions.
5. **Commit** -- One commit per module, with PROGRESS.md updated.

### When to Stop and Ask

Claude should stop and surface a question (in PROGRESS.md under Open Questions, and in the commit message) when:

- A design choice contradicts or isn't covered by the principles in DISTILLATION.md
- The scouting report reveals essential functionality that the roadmap explicitly deferred
- An interface decision would constrain a future module in a way not anticipated here
- The implementation is significantly larger or more complex than expected (suggesting the scope was underestimated)
- Two modules want incompatible interfaces

These are logged, not blocking. Claude should make its best judgment call, document the reasoning, and continue. The human reviews at module boundaries.

---

## Decision Authority

### Decisions Claude Can Make

These follow directly from DISTILLATION.md principles and established patterns:

- **Interface design** -- Choosing function signatures, type shapes, error types. Precedent: embeddings module's `EmbeddingProvider` interface.
- **What to omit** -- Removing accidental complexity identified in scouting reports (unused config, dead code paths, over-generalized abstractions). This is the core distillation act.
- **Implementation approach** -- Choosing data structures, algorithms, internal organization within a module. Must follow coding philosophy in CLAUDE.md (immutability, Rust-compatible TypeScript, clarity over brevity).
- **Test strategy** -- Deciding what to test and how, following `docs/testing-strategy.md` (leaf layers mock externals, core layers use pure functions, orchestration mocks only external boundaries).
- **Module-internal boundaries** -- Splitting or merging functions/types within a single module.

### Decisions That Need Discussion

These involve cross-module architectural choices or scope changes:

- **Adding scope** -- If a module seems to need functionality not in the roadmap, flag it. Don't build it.
- **Changing interfaces of completed modules** -- If a new module needs a different interface from an already-built module, document the need rather than changing the existing module.
- **Promoting a deferred item** -- If deferred functionality (e.g., vector search) turns out to be needed earlier than planned, flag it.
- **New architectural decisions** -- Choices that would be added to the "Key Decisions" list in PROGRESS.md.

### Pre-Resolved Decisions

These were discussed during roadmap creation and are settled:

1. **File-based storage, not SQLite** -- OpenClaw uses file-based storage (JSON metadata, JSONL transcripts) for sessions and conversation history. SQLite is only used for the derived memory search index. Since we are deferring vector search, there is no need for SQLite in the initial system. Storage is JSON/JSONL files with atomic writes (no locking needed -- see decision #8).

2. **One conversation per agent** -- There are no "sessions." Each agent has exactly one conversation that persists indefinitely, compacted as needed. No session IDs, no session listing, no reset policies. This follows from one-agent-per-process: one agent, one conversation, one process. If the user wants a separate conversation thread, they start another agent. OpenClaw's session concept (daily resets, idle timeouts, session keys) exists to multiplex many conversations within one process -- with that multiplexing eliminated, sessions have no purpose. The "Conversation Store" replaces "Session Store."

3. **Single-agent, routing as stub** -- Routing resolves every message to the one active session. The interface is designed for multi-agent dispatch so it can be replaced later, but the implementation is trivial.

4. **History Management merges into Context Window** -- In the original, these are separate because history has independent pruning rules. With a single session and modern context windows, the distilled version treats history management as a policy within the Context Window module, not a separate module. The interface allows separating them later if needed.

5. **Agent Alignment is thin** -- The scouting report covers plugin hooks, skills config, extension loading -- all dropped per "no plugin hooks for core behavior" (Decision #2 in PROGRESS.md). What remains: system prompt assembly (including identity file loading) and a tool registry. Two modules, not three -- project detection and workspace bootstrap are not core to agent identity.

6. **Cross-Agent Access is out of scope** -- Already deferred in PROGRESS.md Decision #4. Not on this roadmap.

7. **Vector search, file sync, memory manager deferred** -- These compose the "smart memory" layer that requires SQLite + embeddings infrastructure. The minimal viable agent uses file-based conversation history and does not need semantic search over past sessions. When the time comes, the embeddings module (already built) and the storage interfaces (designed for extensibility) provide the foundation.

8. **One agent per process, no file locking** -- Each agent is its own OS process. OpenClaw's 188-LOC advisory file locking exists because multiple agents in one process can concurrently access the same session files. With one agent per process, there is exactly one writer -- no concurrent access, no locking needed. Atomic writes (write-to-temp, rename) handle crash safety. This decision also eliminates session key namespacing, shared registries, and cross-agent access control within a process. Verified against OpenClaw source: agent-to-agent communication is already asynchronous message passing through session transcripts, not shared in-process state. Separate processes make this logical isolation physical.

9. **Storage is generic, not session-aware** -- The Storage module provides file I/O primitives: read/write JSON, append/read JSONL. It does not know about sessions, messages, or metadata schemas. Session Store is the first consumer and adds session-specific semantics. This respects layer boundaries (Principle 8): a storage layer stores, it doesn't interpret. The interface cost is near zero (`read<T>(key)` vs `readSession(id)`) and the separation keeps Storage reusable if other consumers appear.

10. **JSONL for transcripts, JSON for metadata** -- Transcripts are append-only logs (JSONL): O(1) append, no read-modify-write. Session metadata is a single JSON document: small, read-modify-write is fine with atomic writes. This matches OpenClaw's approach and the tradeoffs are sound for both current and future scale.

11. **Base directory injection, no platform conventions** -- Storage accepts a base directory as a constructor parameter. No XDG, no ~/.config defaults, no platform detection. The caller decides where files live. This keeps Storage focused on I/O and makes testing trivial (use a temp directory).

12. **Context Window is a pure function** -- Caller passes in messages and a token budget. Context Window returns the messages that fit and reports what was dropped. It does not know about models, API limits, or compaction. The Agent Loop computes the budget (model context limit minus system prompt minus response reserve) and decides whether to trigger compaction based on Context Window's overflow report. No separate history policies (max messages, max age) -- the token budget is the only policy.

13. **Claude API message types, not a custom format** -- Komatachi is explicitly built for Claude. Transcript messages use Claude's API message format (user/assistant roles, content blocks with text/tool_use/tool_result). No provider-agnostic abstraction layer. This eliminates a translation layer and means the transcript is directly usable as API input. If Rust portability requires it, we define a minimal mirror of Claude's types rather than an abstraction over multiple providers.

14. **System prompt is a simple function, not a registry** -- The system prompt is assembled by a function that calls section builders in order. No dynamic section registry, no add/replace mechanism. The section list is known at compile time. If you want to change sections, change the code. A registry adds indirection without value for a single-agent system.

15. **String interpolation, no template engine** -- Variable substitution in system prompt sections uses template literals (`${variable}`). The dynamic content is simple (timestamps, tool lists, identity file contents). A template engine would be accidental complexity.

16. **Identity files are user-editable markdown** -- The agent's sense of self comes from user-editable markdown files in the agent's home directory: SOUL.md (personality, values), IDENTITY.md (name, characteristics), USER.md (context about the human), MEMORY.md (long-term curated memory), AGENTS.md (behavioral guidelines), TOOLS.md (tool-specific notes). The system prompt builder loads these and injects their contents. OpenClaw's bootstrap file system is one of its best ideas -- simple, auditable, and directly serving the vision of persistent AI entities with evolving identity. No template initialization system; the human creates these files (or asks the agent for help).

17. **Tool registry is a flat array, no profiles or permissions** -- Tools are an array of definitions: name, description, input schema, handler. No tool groups, no profiles (minimal/coding/full), no allow/deny lists. With one agent, one set of tools, the registry *is* the policy. If per-context restrictions are needed later, the Agent Loop filters the array before passing it to the API.

18. **No project detection in the minimal agent** -- Project awareness (git root, project type, project config) is a coding-assistant concern, not core agent identity. The minimal agent has identity, memory, conversation, and tools. "I can look at this codebase" is a capability module for later, not a system prompt section. This eliminates Phase 3.3 (Workspace Bootstrap) entirely.

19. **Use @anthropic-ai/sdk directly** -- OpenClaw uses `@mariozechner/pi-ai`, a provider-agnostic wrapper. Komatachi is built for Claude (decision #13), so we use the official Anthropic SDK directly. It handles retries, types, and error handling. No wrapper, no abstraction. The Rust version will need a different client anyway, so there's no portability benefit to abstracting now.

20. **Non-streaming initially** -- The agent loop gets the complete response before processing it. Streaming is better UX (text appears incrementally) but adds complexity to response handling, tool dispatch, and conversation persistence. Non-streaming keeps the loop simple: call -> get response -> process -> persist. Streaming can be added later without changing the loop's logical structure.

---

## The Roadmap

### Phase 1: Storage & Session Foundation

The persistence layer everything else builds on.

**1.1 -- Storage**

Scope: Generic file-based persistence primitives. JSON read/write with atomic operations. JSONL append-only logs. No domain knowledge (sessions, messages, etc.).

Source material: `scouting/session-management.md` (store.ts ~440 lines, transcript.ts ~133 lines, paths.ts ~73 lines). Study for patterns, not for domain coupling.

What to build:
- JSON store: `read<T>(path)`, `write<T>(path, data)` with atomic write (write-to-temp, rename)
- JSONL log: `append<T>(path, entry)`, `readAll<T>(path)`, `readRange<T>(path, start, end)`, `writeAll<T>(path, entries)` (atomic rewrite -- needed for compaction's transcript replacement)
- Crash resilience: `readAll<T>` must handle partial trailing lines (incomplete writes from crash mid-append). Skip the incomplete line rather than failing.
- Base directory resolution: accept root dir as constructor/parameter, derive paths beneath it
- Error types: `StorageNotFoundError`, `StorageCorruptionError`, `StorageIOError`

What to omit:
- SQLite (deferred -- see Pre-Resolved Decision #1)
- File locking / advisory locks (unnecessary -- see Pre-Resolved Decision #8)
- Caching layer (separate concern above storage)
- Migration logic (no legacy data to migrate)
- Session/message/metadata awareness (that's Session Store's job -- see Pre-Resolved Decision #9)

**1.2 -- Conversation Store**

Scope: Persist and load the single conversation for this agent. Append messages, read history, store metadata. No session IDs, no lifecycle state machine, no multi-conversation management.

Source material: `scouting/session-management.md` (store.ts ~440 lines, transcript.ts ~133 lines). Study for file format patterns; discard session multiplexing, reset policies, and key resolution.

What to build:
- Conversation metadata: JSON file with timestamps, compaction count, model config
- Message appending: append Claude API messages to JSONL transcript via Storage
- Conversation loading: read metadata + full transcript into memory on startup
- Conversation initialization: create metadata + empty transcript if none exists
- Transcript replacement: `replaceTranscript(messages)` atomically rewrites the JSONL transcript and updates in-memory state (required for compaction)
- In-memory state: Conversation Store holds messages in memory after `load()`. `appendMessage()` writes to both memory and disk. `getMessages()` returns from memory (no I/O). `replaceTranscript()` replaces both. This is explicit, owned state (Principle 2).

What to omit:
- Session IDs, session keys, session listing (see Pre-Resolved Decision #2)
- Lifecycle state machine (no Created/Active/Compacting/Ended -- the conversation just exists)
- Reset policies (daily/idle timeouts -- see Pre-Resolved Decision #2)
- Session search/filtering, auto-cleanup, TTL, forking

---

### Phase 2: Context Pipeline

How conversations are managed within token limits.

**2.1 -- Context Window**

Scope: Pure function. Given a conversation history and a token budget (provided by caller), select the messages that fit. Does not know about models, API limits, or compaction. Reports what it dropped so the caller can decide whether to trigger compaction.

Source material: `scouting/context-management.md` (~2,630 lines total; context assembly + pruning + history limiting).

What to build:
- Message selection: given messages + token budget, return the messages that fit (most recent first)
- Overflow reporting: when messages are dropped, return metadata about what was dropped (count, estimated tokens) so the caller (Agent Loop) can decide to compact
- Compacted history handling: a compaction summary is just another message at the start of history -- no special treatment needed, it's already in Claude API format
- Token estimation: injected as a parameter, not imported from compaction. `selectMessages(messages, budget, estimateTokens)` -- the caller (Agent Loop) passes the estimator function, keeping Context Window a pure function with zero module dependencies. A shared `estimateStringTokens(text): number` utility should also exist (same formula) for Agent Loop to estimate system prompt size when computing the token budget.

What to omit:
- Token budget computation (caller's job -- Agent Loop knows the model's context limit, system prompt size, response reserve)
- Compaction triggering (caller's job -- Context Window reports overflow, Agent Loop decides)
- History policies (max messages, max age) -- the token budget *is* the policy; with one conversation and compaction, separate limits are redundant
- Multi-stage summarization, adaptive ratios, priority-based retention
- Token counting for tool definitions (the LLM API handles this)

Design: Context Window is stateless and has no dependencies on Compaction or Conversation Store. It receives messages as input and returns selected messages as output. This makes it trivially testable and keeps layer boundaries clean.

Future note: when compaction is triggered, the Agent Loop could augment the compaction input with message age information, enabling the compaction summarizer to make better decisions about what to preserve vs. condense. This doesn't require changes to Context Window -- it's a concern at the Agent Loop level.

---

### Phase 3: Agent Identity

How the agent knows who it is and what it can do.

**3.1 -- System Prompt**

Scope: Assemble the system prompt that defines the agent's sense of self. This includes loading identity files (SOUL.md, IDENTITY.md, etc.) from the agent's home directory and composing them with tool definitions and runtime metadata into a complete system prompt.

Source material: `scouting/agent-alignment.md` (system-prompt.ts ~591 lines, workspace.ts ~288 lines). Study for the section-builder pattern and bootstrap file concepts; discard plugin hooks, skills injection, multi-channel sections.

What to build:
- Identity file loading: given the agent's home directory, read SOUL.md, IDENTITY.md, USER.md, MEMORY.md, AGENTS.md, TOOLS.md. Return their contents (or null if missing). This is a pure function, not a separate module.
- Section builders: ordered functions that each produce a section of the system prompt (identity, tools, runtime metadata). Each returns a string array of lines.
- Prompt assembly: compose section outputs into the final system prompt string. String interpolation for dynamic content (current time, tool list).
- Runtime metadata: current timestamp, environment info -- simple values injected into the prompt.

What to omit:
- Section registry / dynamic add-replace (see Pre-Resolved Decision #14)
- Template engine (see Pre-Resolved Decision #15)
- Plugin hooks for prompt modification
- Dynamic prompt adjustment based on conversation state
- Skills/capability injection from extensions
- Prompt versioning or A/B testing
- Project detection / workspace context (see Pre-Resolved Decision #18)
- Template initialization / first-run bootstrap (human creates identity files)

**3.2 -- Tool Registry**

Scope: Define the agent's tools as a flat array of definitions. Each tool has a name, description, input schema, and handler function. The registry is the policy -- every tool in the array is available to the agent.

Source material: `scouting/agent-alignment.md` (tool-policy.ts ~234 lines, types.tools.ts ~450 lines). Study for tool definition structure; discard profiles, groups, plugin tool expansion, allow/deny lists.

What to build:
- Tool definition type: name, description, input schema (JSON Schema), handler function
- Tool definition export: format the tool array into Claude's API tool format (name, description, input_schema) for the API call. The handler stays on our side.
- Tool result type: structured return from tool execution (success with content, or error)

What to omit:
- Tool groups and profiles (see Pre-Resolved Decision #17)
- Allow/deny lists, permission model
- Dynamic tool enabling/disabling mid-conversation
- Tool usage analytics or fallback chains
- Plugin tool discovery and expansion

---

### Phase 4: Agent Loop

**4.1 -- Agent Loop**

Scope: The main execution loop that ties everything together. Accept user input, build context, call Claude, process response, persist to conversation.

With one agent, one conversation, and no routing, this is the agent's main loop. It wires together Conversation Store, Context Window, System Prompt, Tool Registry, and the Claude API.

Source material: OpenClaw uses `@mariozechner/pi-ai` (a provider-agnostic wrapper). Komatachi uses `@anthropic-ai/sdk` directly -- no abstraction layer needed (see Pre-Resolved Decision #13). Study OpenClaw's agent loop structure for the execution pattern; discard the provider abstraction.

What to build:
- Claude API client: use `@anthropic-ai/sdk` directly. Non-streaming initially (see Pre-Resolved Decision #20). The SDK handles retries, types, and error handling.
- Main loop: read input -> build context (system prompt + history within budget) -> call Claude API -> handle response (text, tool calls) -> append to conversation -> repeat
- Tool execution dispatch: when Claude returns tool_use, execute the handler from the Tool Registry, format as tool_result, append both to conversation, call Claude again. Simple sequential loop.
- Compaction triggering: when Context Window reports overflow (messages dropped), trigger compaction via the existing `src/compaction/` module. Simplest policy: compact when any messages are dropped.
- Compaction type alignment: the existing compaction module uses its own Message type (trial distillation, pre-decision #13). Update it to accept Claude API message format when wiring into the Agent Loop. `extractToolFailures()` needs updating to find tool_result blocks in user messages instead of a "toolResult" role.
- FileOperations: compaction accepts file operation data (files read/modified). No module currently tracks this. Pass empty file operations for now -- compaction still works, it just won't include file lists in summaries. Add tracking when tools report file operations.
- Error handling: surface Claude API errors to the caller. No retries beyond what the SDK provides. Fail clearly (Principle 7).
- Graceful shutdown: persist conversation state on exit

What to omit:
- Provider abstraction layer (see Pre-Resolved Decision #19)
- Streaming (see Pre-Resolved Decision #20)
- Multi-agent dispatch
- Channel-specific routing
- Message queue or load balancing
- Background processing or async job handling
- Parallel tool execution (sequential is sufficient initially)

---

### Phase 5: Integration

**5.1 -- Integration Validation**

Scope: Verify that all modules compose correctly into a working agent loop.

What to build:
- Integration test: user message in -> conversation store append -> context window selection -> system prompt assembly -> Claude API call (mocked) -> response handling -> conversation store append
- Tool dispatch test: mock Claude returning tool_use -> tool handler executes -> tool_result appended -> mock Claude called again with result
- Compaction trigger test: simulate overflow -> verify compaction is triggered
- Verify the full pipeline works end-to-end with mocked Claude API
- Identify any interface mismatches between modules

This is the checkpoint where we verify the architecture holds together. Any interface friction discovered here gets resolved before building further.

---

### Deferred Work (Out of Scope)

Explicitly not on this roadmap. Documented here so future sessions don't re-derive these decisions.

| Item | Reason Deferred |
|------|----------------|
| Vector search index (SQLite + sqlite-vec) | No semantic search needed for minimal viable agent. Embeddings module is ready when needed. |
| File sync / file watching | Only needed for memory indexing, which depends on vector search. |
| Memory Manager | Orchestrator for search + sync + embeddings. Deferred with its dependencies. |
| Cross-Agent Access | Multi-agent feature. Single-agent assumption for now (PROGRESS.md Decision #4). |
| BM25 / hybrid search | Already decided against (PROGRESS.md Decision #3). Vector-only when search is added. |
| Multi-conversation management | One conversation per agent. Want another thread? Start another agent. |
| Multi-agent routing | One agent per process. Inter-agent communication is IPC, not in-process routing. |
| Gateway / IPC broker | Only needed for multi-agent or multi-client. Single-process for now (PROGRESS.md Decision #7). |
| Project detection / workspace context | Coding-assistant concern, not core agent identity. Add as a capability module when needed. |

---

## Tracking Progress

As each module is completed:

1. Update PROGRESS.md with completion status, metrics (LOC, test count), and any insights
2. Move to the next roadmap item
3. If a module surfaces an issue with a previous module's interface, document it in PROGRESS.md under Open Questions rather than modifying the completed module

The roadmap is a plan, not a prison. If the plan is wrong, document why and propose an adjustment. But the bar for deviation is high -- most "this needs to change" impulses are better resolved by working within the constraints than by changing them.
