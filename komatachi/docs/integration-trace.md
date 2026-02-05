# Integration Trace

How each component composes into the minimal viable agent loop. This document verifies that interfaces fit together before implementation begins.

---

## Component Interfaces (Abstract)

### Storage

```
Storage(baseDir: string)
  readJson<T>(path: string): Promise<T>                     -- throws StorageNotFoundError, StorageCorruptionError
  writeJson<T>(path: string, data: T): Promise<void>        -- atomic: write-to-temp, rename
  appendJsonl<T>(path: string, entry: T): Promise<void>     -- append single line
  readAllJsonl<T>(path: string): Promise<T[]>               -- read all lines
  writeJsonl<T>(path: string, entries: T[]): Promise<void>  -- atomic: rewrite entire file (needed for compaction)
```

State: none (pure I/O). Callers: Conversation Store, Identity file loading.

### Conversation Store

```
ConversationStore(storage: Storage, conversationDir: string)
  load(): Promise<{ metadata: ConversationMetadata, messages: Message[] }>  -- read from disk into memory
  initialize(): Promise<void>                              -- create metadata + empty transcript if none exists
  appendMessage(message: Message): Promise<void>           -- append to memory + disk
  getMessages(): readonly Message[]                        -- return in-memory messages (no disk read)
  replaceTranscript(messages: Message[]): Promise<void>    -- atomic rewrite (for compaction)
  updateMetadata(updates: Partial<ConversationMetadata>): Promise<void>
```

State: in-memory copy of messages + metadata (synced to disk on writes). Callers: Agent Loop.

### Context Window

```
selectMessages(
  messages: readonly Message[],
  tokenBudget: number,
  estimateTokens: (msg: Message) => number    -- injected, not imported
): { selected: readonly Message[], overflow: OverflowReport | null }
```

```
OverflowReport = { droppedCount: number, estimatedDroppedTokens: number }
```

State: none (pure function). Callers: Agent Loop.

### System Prompt

```
loadIdentityFiles(homeDir: string): Promise<IdentityFiles>

buildSystemPrompt(
  identity: IdentityFiles,
  tools: readonly ToolDefinition[],
  runtime: RuntimeInfo
): string
```

```
IdentityFiles = {
  soul: string | null        -- SOUL.md
  identity: string | null    -- IDENTITY.md
  user: string | null        -- USER.md
  memory: string | null      -- MEMORY.md
  agents: string | null      -- AGENTS.md
  tools: string | null       -- TOOLS.md
}

RuntimeInfo = { currentTime: string }
```

State: none (pure functions + file reads). Callers: Agent Loop.

### Tool Registry

```
ToolDefinition = {
  name: string
  description: string
  inputSchema: JSONSchema
  handler: (input: unknown) => Promise<ToolResult>
}

ToolResult = { ok: true, content: string } | { ok: false, error: string }

exportForApi(tools: readonly ToolDefinition[]): ApiToolDefinition[]
  -- strips handler, returns Claude API format: { name, description, input_schema }
```

State: none (data + pure function). Callers: Agent Loop.

### Compaction (already built)

```
compact(messages: Message[], fileOps: FileOperations, config: CompactionConfig): Promise<CompactionResult>
  -- config.summarize is a callback that calls Claude
  -- returns { summary: string, inputTokens: number, metadata: CompactionMetadata }

estimateTokens(message: Message): number
  -- ~4 chars/token approximation
```

State: none. Callers: Agent Loop (via Context Window overflow trigger).

### Agent Loop

```
AgentLoop(config: {
  storage: Storage
  conversationDir: string
  homeDir: string               -- agent's identity files location
  tools: ToolDefinition[]
  model: string                 -- e.g., "claude-sonnet-4-20250514"
  maxTokens: number             -- response token limit
  contextWindow: number         -- model's context window size
  apiKey: string
})

processTurn(userInput: string): Promise<string>  -- one full turn: user message in, final text response out
```

State: owns ConversationStore instance, holds identity/tools/config. Callers: CLI (or whatever interface).

---

## Full Turn Trace: Normal Message

```
User types "Hello"
│
├─ Agent Loop receives input
│  │
│  ├─ 1. Create user message: { role: 'user', content: 'Hello' }
│  ├─ 2. conversationStore.appendMessage(userMsg)
│  │     └─ appends to in-memory array + appends line to transcript.jsonl
│  │
│  ├─ 3. Build system prompt (may rebuild every turn -- identity files could change)
│  │     ├─ loadIdentityFiles(homeDir)
│  │     │   └─ reads SOUL.md, IDENTITY.md, etc. via fs (or Storage)
│  │     ├─ buildSystemPrompt(identity, tools, { currentTime: now() })
│  │     │   └─ calls section builders in order, returns assembled string
│  │     └─ systemPrompt: string
│  │
│  ├─ 4. Compute token budget
│  │     ├─ systemPromptTokens = estimateTokens(systemPromptAsMessage)
│  │     ├─ budget = contextWindow - systemPromptTokens - maxTokens (response reserve)
│  │     └─ budget: number
│  │
│  ├─ 5. Select messages for context
│  │     ├─ messages = conversationStore.getMessages()
│  │     ├─ selectMessages(messages, budget, estimateTokens)
│  │     └─ { selected, overflow: null }
│  │
│  ├─ 6. Call Claude API
│  │     ├─ anthropic.messages.create({
│  │     │     model,
│  │     │     system: systemPrompt,
│  │     │     messages: selected,
│  │     │     tools: exportForApi(tools),
│  │     │     max_tokens: maxTokens
│  │     │  })
│  │     └─ response: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] }
│  │
│  ├─ 7. conversationStore.appendMessage(assistantMsg)
│  │     └─ appends to in-memory array + appends line to transcript.jsonl
│  │
│  └─ 8. Return "Hi!" to caller
```

**Interfaces involved**: Storage <- Conversation Store <- Agent Loop -> System Prompt, Tool Registry, Context Window, Claude API

---

## Full Turn Trace: Tool Use

```
User types "What time is it?"
│
├─ Steps 1-5: same as above
│
├─ 6. Call Claude API
│     └─ response: { role: 'assistant', content: [
│          { type: 'text', text: 'Let me check.' },
│          { type: 'tool_use', id: 'toolu_123', name: 'get_time', input: {} }
│        ]}
│
├─ 7. conversationStore.appendMessage(assistantMsg)   -- includes tool_use blocks
│
├─ 8. Tool dispatch loop:
│     ├─ For each tool_use in response.content:
│     │   ├─ Find handler: tools.find(t => t.name === 'get_time').handler
│     │   ├─ Execute: handler({}) → { ok: true, content: '2026-02-05T14:30:00Z' }
│     │   └─ Build tool_result content block:
│     │       { type: 'tool_result', tool_use_id: 'toolu_123', content: '14:30:00Z' }
│     │
│     ├─ Create tool_result message: { role: 'user', content: [tool_result_blocks] }
│     ├─ conversationStore.appendMessage(toolResultMsg)
│     │
│     ├─ Re-run steps 3-6 with updated messages
│     │   (system prompt + context window + Claude API call)
│     │
│     └─ response: { role: 'assistant', content: [{ type: 'text', text: 'It is 2:30 PM.' }] }
│
├─ 9. conversationStore.appendMessage(finalAssistantMsg)
│
└─ 10. Return "It is 2:30 PM." to caller
```

**Key**: The tool dispatch loop means a single `processTurn()` may call Claude multiple times. Each intermediate message (assistant with tool_use, user with tool_result) is persisted to the conversation before the next API call. This means a crash mid-turn preserves partial progress.

---

## Full Turn Trace: Compaction Triggered

```
User sends message (conversation is long, ~500 messages)
│
├─ Steps 1-4: same as above
│
├─ 5. Select messages for context
│     ├─ selectMessages(500 messages, budget, estimateTokens)
│     └─ { selected: [last 100 msgs], overflow: { droppedCount: 400, estimatedTokens: 150000 } }
│
├─ 6. Overflow detected → compact before proceeding
│     │
│     ├─ 6a. Prepare compaction
│     │   ├─ allMessages = conversationStore.getMessages()  -- all 500
│     │   ├─ fileOps = { read: Set(), edited: Set(), written: Set() }
│     │   │   NOTE: fileOps tracking is a future concern. For now, pass empty.
│     │   │   Compaction still works -- it just won't include file operations in summary.
│     │   ├─ summarizer = createSummarizer({ contextWindow, callModel: claudeCall })
│     │   └─ config = { maxInputTokens, summarize: summarizer }
│     │
│     ├─ 6b. Call compact(messagesToCompact, fileOps, config)
│     │   ├─ Validates input size
│     │   ├─ Extracts tool failures from messages
│     │   ├─ Calls summarizer (which calls Claude) → summary text
│     │   └─ Returns { summary, inputTokens, metadata }
│     │
│     ├─ 6c. Build compaction summary message
│     │   ├─ summaryMsg = { role: 'user', content: summary }
│     │   │   NOTE: This is a user message so Claude sees it as context.
│     │   │   It's the "compacted history" -- just another message at the start.
│     │   └─ keptMessages = selected messages from step 5
│     │
│     ├─ 6d. Replace transcript
│     │   ├─ conversationStore.replaceTranscript([summaryMsg, ...keptMessages])
│     │   │   └─ Atomically rewrites transcript.jsonl
│     │   ├─ conversationStore.updateMetadata({ compactionCount: count + 1 })
│     │   └─ In-memory state now reflects compacted conversation
│     │
│     └─ 6e. Re-select messages (now fits within budget)
│           ├─ selectMessages(compactedMessages, budget, estimateTokens)
│           └─ { selected: all compacted messages, overflow: null }
│
├─ 7-8. Proceed with Claude API call and response handling (same as normal turn)
│
└─ Return response to caller
```

---

## Interface Gaps Found

### 1. Conversation Store needs `replaceTranscript()`

**The roadmap spec says**: append, load, initialize.
**Compaction requires**: replacing the entire transcript with [summary + kept messages].

The Conversation Store must have a `replaceTranscript(messages: Message[]): Promise<void>` that atomically rewrites the JSONL file and updates in-memory state. Without this, compaction cannot persist its results.

**Storage implication**: Storage needs a `writeJsonl<T>(path, entries)` operation (atomic rewrite of an entire JSONL file), in addition to `appendJsonl` (append single entry). This is already implied by atomic writes but should be explicit in the interface.

### 2. Token estimation should be a shared utility, not a compaction import

Context Window needs `estimateTokens()`. It's currently defined in `src/compaction/index.ts`. If Context Window imports from Compaction, it creates a dependency between two modules that should be independent.

**Resolution**: Extract `estimateTokens()` and `estimateMessagesTokens()` into a shared utility (e.g., `src/tokens/index.ts` or `src/shared/tokens.ts`). Both Compaction and Context Window import from there. Alternatively, Context Window accepts `estimateTokens` as an injected parameter (shown in the interface above).

The injected parameter approach is cleaner: Context Window remains a pure function with zero imports from other modules. The Agent Loop passes the estimator.

### 3. Compaction's Message type doesn't match Claude API format

The existing compaction module defines its own `Message` type:
```typescript
interface Message {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  // ...
}
```

Claude's API uses a different structure: tool results are content blocks within a user message, not separate messages with a "toolResult" role.

**Resolution**: When the Conversation Store and Agent Loop use Claude API types (decision #13), the compaction module's Message type needs to be updated or an adapter is needed. Since compaction was a "trial distillation" built before the Claude-API-types decision, it should be updated during Phase 4 (Agent Loop) to accept Claude API message format directly. The existing `extractToolFailures()` logic would need to extract tool_result blocks from user messages instead of looking for `role === "toolResult"`.

This is a known interface mismatch. Flag it now; resolve when wiring compaction into the Agent Loop.

### 4. FileOperations tracking is not in any module's scope

The compaction module expects `FileOperations` (which files were read/modified). No current module tracks this. For the minimal agent, pass empty file operations. Compaction still works -- it just won't include file lists in the summary. File tracking can be added later when tools report their file operations.

### 5. Conversation Store needs in-memory state management

The Conversation Store must keep messages in memory between calls. Otherwise the Agent Loop would re-read from disk on every `getMessages()` call. This means:

- `load()` reads from disk into memory
- `appendMessage()` appends to both memory and disk
- `getMessages()` returns from memory (no I/O)
- `replaceTranscript()` replaces both memory and disk

This is explicit, owned state (Principle 2) -- not hidden. The Conversation Store owns its message cache, and all mutations go through its methods.

### 6. System prompt token estimation

The Agent Loop needs to estimate the system prompt's token count to compute the context budget. The system prompt is a string, but `estimateTokens()` expects a Message. Either:
- Add a `estimateStringTokens(text: string): number` utility alongside message estimation
- Wrap the system prompt in a fake message for estimation

The string utility is cleaner. It's just `Math.ceil(text.length / 4)` -- the same formula.

---

## Dependency Graph

```
                    ┌─────────────┐
                    │   CLI / UI  │
                    └──────┬──────┘
                           │ processTurn(input)
                           ▼
                    ┌─────────────┐
                    │  Agent Loop │ ◄── orchestrates everything
                    └──┬──┬──┬──┬┘
                       │  │  │  │
          ┌────────────┘  │  │  └──────────────┐
          ▼               │  │                  ▼
   ┌──────────────┐       │  │         ┌──────────────┐
   │ Conversation │       │  │         │  Claude API   │
   │    Store     │       │  │         │ (@anthropic-  │
   └──────┬───────┘       │  │         │  ai/sdk)      │
          │               │  │         └──────────────┘
          ▼               │  │
   ┌──────────────┐       │  │
   │   Storage    │       │  │
   │ (file I/O)   │       │  │
   └──────────────┘       │  │
                          │  │
              ┌───────────┘  └───────────┐
              ▼                          ▼
      ┌──────────────┐          ┌──────────────┐
      │   Context    │          │   System     │
      │   Window     │          │   Prompt     │
      │ (pure func)  │          │ (identity +  │
      └──────────────┘          │  assembly)   │
                                └──────────────┘
              │
              │ overflow triggers
              ▼
      ┌──────────────┐          ┌──────────────┐
      │  Compaction  │          │    Tool      │
      │ (existing)   │ ◄────── │   Registry   │
      └──────────────┘          └──────────────┘
              │                        │
              │ calls Claude           │ handler dispatch
              └────────► Claude API ◄──┘
```

Note: Compaction calls Claude through the same API client. Tool handlers call Claude indirectly (they do their work, not LLM calls). The Agent Loop mediates all Claude API calls.

---

## Verification: Can a Persistent Agent Loop Work?

Tracing the complete lifecycle:

1. **First startup**: Agent Loop creates Conversation Store → `initialize()` creates empty transcript + metadata. Identity files loaded. System prompt built. No messages yet.

2. **First message**: User input → append → select (fits easily) → call Claude → append response → return text. Transcript has 2 entries.

3. **Many messages**: Same loop, messages accumulate in JSONL. Each append is O(1). Load on startup reads all lines.

4. **Context overflow**: Context Window reports overflow → Agent Loop calls Compaction → Compaction calls Claude for summary → Agent Loop calls `replaceTranscript()` → new compact transcript persisted → loop continues.

5. **Crash recovery**: On restart, `load()` reads the transcript from disk. If crash happened mid-append, the JSONL file has a partial last line — `readAllJsonl` should handle this (skip incomplete trailing line). All persisted messages are recovered. At worst, the last message before crash is lost.

6. **Shutdown**: Agent Loop calls... nothing special. All messages are already persisted (appended after each Claude response). Metadata is updated after compaction. No flush needed.

**Result: Yes, it works.** The interfaces compose. The gaps identified above (#1-6) are real but solvable within the planned module boundaries.

---

## Summary of Required Updates to Roadmap

| # | Gap | Resolution | Which Phase |
|---|-----|------------|-------------|
| 1 | Conversation Store needs `replaceTranscript()` | Add to Phase 1.2 spec | 1.2 |
| 2 | Token estimation shared utility | Inject as parameter to Context Window, or extract to `src/shared/` | 2.1 |
| 3 | Compaction Message type mismatch | Update compaction to accept Claude API format when wiring into Agent Loop | 4.1 |
| 4 | FileOperations not tracked | Pass empty for now; add tracking later | 4.1 (note) |
| 5 | Conversation Store in-memory cache | Design into Phase 1.2 (explicit owned state) | 1.2 |
| 6 | String token estimation | Add `estimateStringTokens()` alongside existing message estimator | 2.1 or shared |
| 7 | Partial JSONL line on crash | Storage `readAllJsonl` should skip incomplete trailing line | 1.1 |
