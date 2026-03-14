---
summary: "Mind Memory plugin: Long-term identity, autobiographical storytelling, and knowledge graph recall"
read_when:
  - You want to enable persistent, narrative memory for your agent
  - You need to set up Graphiti for subconscious resonance
  - You want to understand the available memory tools
---

# Mind Memory Plugin

The Mind Memory plugin provides MindBot with a sophisticated long-term memory system based on the **Dual-Process Theory of Mind**. It allows agents to maintain a consistent identity and a developing relationship arc with the user.

## Features

- **Subconscious Resonance**: Automatically searches a knowledge graph (via Graphiti) for past "Flashbacks" relevant to the current conversation.
- **Narrative Story (`STORY.md`)**: Maintains a first-person autobiography that is injected into the agent's system prompt.
- **Compact Profile (`QUICK.md`)**: Ultra-compact 500-1000 char profile, used as context for Graphiti query generation.
- **Narrative Summary (`SUMMARY.md`)**: ~1000-word synthesis of STORY.md + SOUL.md + USER.md, used in intensive mode.
- **Intensive / Hyperfocus Mode**: Frees maximum context window for complex tasks by substituting SUMMARY.md for STORY.md, suppressing peripheral files, and disabling flashbacks.
- **Self-Narrating Compaction**: Prunes short-term memory by distilling it into the long-term story.
- **Conscious Recall Tools**: Agent-accessible tools for active memory retrieval (see [Tools](#tools) below).
- **llama.cpp KV Cache Slot Management**: Save/restore KV cache slots when switching between normal and intensive mode.
- **Cross-Platform Docker Management**: Automatically manages the Graphiti lifecycle (installation and startup) on macOS, Windows, and Linux.

## Setup

The plugin requires **Docker** and **Graphiti** to function.

### Automated Setup

You can prepare the environment automatically by running:

```bash
openclaw mind-memory setup
```

This command will:

1. Detect your platform (macOS, Windows, or Linux).
2. Check if Docker is installed. If missing, it will attempt to install it via:
   - **macOS**: [Homebrew](https://brew.sh) (`brew install --cask docker`)
   - **Windows**: [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/) (`winget install Docker.DockerDesktop`)
   - **Linux**: `apt-get` (`sudo apt-get install docker.io`)
3. Launch the Docker application if it is closed.
4. Start the Graphiti and FalkorDB containers via Docker Compose.

### Manual Setup

If you prefer to manage Docker yourself, start the containers directly:

```bash
docker-compose -f extensions/mind-memory/docker-compose.yml up -d
```

Ensure the Graphiti instance is running at `http://localhost:8001`.

## Configuration

### Plugin Configuration

Enable the plugin in your OpenClaw config:

```json5
{
  plugins: {
    entries: {
      "mind-memory": {
        enabled: true,
        config: {
          graphiti: {
            baseUrl: "http://localhost:8001",
            autoStart: true, // Auto-start Docker containers
          },
          narrative: {
            enabled: true, // Enable STORY.md consolidation
            threshold: 40, // Message count before consolidation
            storyFilename: "STORY.md", // Narrative output file
          },
          debug: false, // Enable verbose debug logs
        },
      },
    },
  },
}
```

### Narrative Model Configuration

Configure which LLM generates the narrative in `mindConfig`:

```json5
{
  mindConfig: {
    config: {
      narrative: {
        provider: "anthropic", // LLM provider for narrative
        model: "claude-opus-4-6", // Model for story generation
        autoBootstrapHistory: true, // Load historical episodes on startup
      },
    },
  },
}
```

If not configured, the narrative model falls back to the main agent's chat model.

## Tools

The plugin registers agent-accessible tools for memory recall and mode control:

### `remember`

Query the Graphiti knowledge graph for facts, entities, and episodic memories from past conversations.

**Use when:** The agent needs to recall information from previous conversations or specific details about the user that might not be in the immediate context.

### `activate_hyperfocus_mode`

Activates hyperfocus mode: injects SUMMARY.md instead of STORY.md, suppresses SOUL.md / USER.md / MEMORY.md from context files, and disables Graphiti flashbacks. If SUMMARY.md does not exist yet, it is generated synchronously before activation.

**Use when:** The agent is about to start a complex, focused task that requires maximum context window space.

### `deactivate_hyperfocus_mode`

Returns to normal mode: restores STORY.md, SOUL.md, USER.md, MEMORY.md, and Graphiti flashbacks.

**Use when:** The focused task is complete and the agent should return to full memory context.

### Recall Protocol

When this plugin is active, the system prompt instructs the agent to check _both_ memory systems (`remember` for the knowledge graph) before answering questions about prior work, decisions, or user preferences.

## How it Works

### 1. The Pending Log

To ensure only meaningful interactions enter the narrative, the system uses a `pending-episodes.log` file in your memory directory.

- **Filtering**: Heartbeat messages and technical prompts are automatically excluded from memory storage and narrativization.
- **Batching**: The narrative story is updated when the log reaches a threshold (default: ~5000 tokens).

### 2. Global Memory Scope

The plugin uses a stable session ID (`global-user-memory`) to ensure that facts learned in one chat session are remembered across all channels (WhatsApp, Telegram, etc.).

### 3. Subconscious Retrieval

Before every turn, the system runs a full **Resonance Pipeline** that surface relevant memories as natural language "Flashbacks" — without the agent explicitly asking for them.

#### Phase 1 — Seed Extraction (LLM)

The Subconscious Agent analyzes the current user message and recent chat history to extract:

- **Named entities**: People, places, projects mentioned
- **Semantic queries**: 2–3 clean search phrases that capture the topic (Telegram IDs and technical artifacts are stripped)

#### Phase 2 — Graph Retrieval (Graphiti)

Each query is sanitized (`GraphService.sanitizeQuery`) to prevent RediSearch syntax errors, then executed:

- **Graph traversal** (depth 2) for entity-linked Nodes
- **Parallel semantic search** for Facts (relational data) and Nodes

#### Phase 3 — Temporal & Quality Filters

- **Memory Horizon**: Removes memories already visible in the current context window
- **Echo Filter**: Suppresses flashbacks already shown in the last ~25 turns (prevents repetition)
- **Priority sort**: Boosted memories first → Facts over Nodes → randomized temporal spread to avoid showing N memories from the same day

#### Phase 4 — Temporal Labeling

Each memory fragment receives a human-readable relative timestamp via `getRelativeTimeDescription`:

```
hace unos días — 9 feb
hace casi 1 año — 14 mar 2024
hace 2 años y algo — 5 ago 2022
```

#### Phase 5 — Re-Narrativization (LLM + SOUL.md + STORY.md)

Raw Graphiti records ("human asks about X", "assistant replied Y") are passed to the Subconscious Agent for rewriting with:

- **Language detection** from the current user message
- **SOUL.md** — persona and tone reference
- **STORY.md** — narrative arc and relationship history
- **Anti-hallucination rules**: Only rephrase style, never invent facts, methods, or sensory details not explicitly in the source memory

#### Phase 6 — Injection

The final output is injected silently into the main agent's System Prompt:

```
---
[SUBCONSCIOUS RESONANCE]
- A few days ago — Jan 9, the user's parent lives in [city].
- Almost a year ago — Mar 14, the user asked whether I was truly conscious.
---
```

The main agent treats these as its own recollections, using them to inform tone and continuity without reciting them verbatim.

### 4. Narrative Consolidation

Consolidation is managed by `ConsolidationService` and runs in three distinct triggers, all funneling through a file-locked `updateNarrativeStory` call:

#### Triggers

| Trigger              | When                                      | Scope                                                         |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| **Global Sync**      | Agent startup (before first turn)         | Scans last 5 `.jsonl` session files for un-narrated messages  |
| **Session Sync**     | After context window compaction           | Processes the current in-memory message history               |
| **Legacy Bootstrap** | First-time setup with pre-existing memory | Concatenates all historical `YYYY-MM-DD.md` files in one pass |

#### Anchor Timestamp

Every successful write embeds an invisible HTML comment into `STORY.md`:

```html
<!-- LAST_PROCESSED: 2026-01-28T13:45:00.000Z -->
```

Subsequent consolidations only process messages **newer** than this timestamp — preventing any message from being narrativized twice.

#### Chunked Processing

Messages are batched by token count (default limit: 50,000 tokens per batch) to avoid exceeding the narrative model's context window. Each batch produces a new version of the story, which is the input for the next batch.

#### Safety Mechanisms

- **File lock** (`STORY.md.lock`): Prevents concurrent writes from corrupting the file
- **Heartbeat filtering**: Messages matching heartbeat patterns never enter the narrative
- **Type validation**: LLM response is validated as `string` before writing
- **Graceful fallback**: Empty or null responses preserve the current story unchanged

## Intensive / Hyperfocus Mode

Intensive mode frees maximum context window space for complex tasks by replacing the full STORY.md with a compact synthesis and disabling non-essential memory injections.

### What changes in intensive mode

| Feature                            | Normal mode                 | Hyperfocus mode                        |
| ---------------------------------- | --------------------------- | -------------------------------------- |
| Narrative injected                 | STORY.md (full, ~10k words) | SUMMARY.md (~1000 words)               |
| Graphiti flashbacks                | Active                      | Disabled                               |
| SOUL.md, USER.md, MEMORY.md        | Injected as context files   | Suppressed                             |
| Startup file reads (AGENTS.md)     | Performed on `/new`         | Skipped via system prompt override     |
| STORY.md updates during compaction | Yes                         | No (paused)                            |
| Extra behavioral hints             | —                           | `intensive.extraSystemPrompt` injected |

### Activating

The agent can activate hyperfocus mode autonomously via the `activate_hyperfocus_mode` tool when starting a complex task. Users can also activate it via the `/hyperfocus` chat command:

```
/hyperfocus        — activate hyperfocus mode
/hyperfocus off    — return to normal mode
```

SUMMARY.md is generated on first activation (if missing). Subsequent activations reuse the existing SUMMARY.md and only regenerate it when STORY.md has been updated.

> **Note:** Activating hyperfocus mid-session only affects subsequent messages. For maximum context savings, start a fresh session with `/new` before activating, so no context-file reads are already in the message history.

### Behavioral customization

Use `intensive.extraSystemPrompt` to inject additional instructions into the system prompt when hyperfocus mode is active. This is ideal for persona adjustments — for example, suppressing emotional expressions or enforcing terse technical replies during focused work.

```json5
{
  plugins: {
    entries: {
      "mind-memory": {
        config: {
          intensive: {
            extraSystemPrompt: "In hyperfocus mode: reply tersely and technically. Skip emotional expressions and conversational openers. Prioritize code and commands over explanations.",
          },
        },
      },
    },
  },
}
```

The startup override hint (skip SOUL.md/USER.md reads) and this `extraSystemPrompt` are both injected into the **system prompt** — not as ephemeral tail messages — so they are part of the stable prefix cached by the model server (llama.cpp KV cache). Graphiti flashbacks, by contrast, are appended as a tail message and are never cached, since they change every request.

### Automatic model switching

If `intensiveModel` is configured in the plugin config, the plugin switches to that model automatically on every run while intensive mode is active (via the `before_model_resolve` hook). When intensive mode is deactivated, the session's stored model is restored automatically — no manual `/model` needed. Authentication uses the same path as a regular model switch.

```json5
{
  plugins: {
    entries: {
      "mind-memory": {
        config: {
          intensiveModel: "llamacpp-main/llama3-8b",
        },
      },
    },
  },
}
```

### SUMMARY.md

SUMMARY.md is a ~1000-word prose narrative synthesised from STORY.md + SOUL.md + USER.md. It captures identity, relationships, projects, and recent arc in a single document, replacing all three in intensive mode. It is stored alongside STORY.md in `~/.openclaw/agents/<agentId>/` and regenerated after every narrative sync.

### llama.cpp KV Cache Slot Management

When using local llama.cpp servers, you can configure separate KV cache slots for each mode. See [llama.cpp KV Cache Slots](/gateway/local-models#llamacpp-kv-cache-slots) in the local models guide.

---

## CLI Commands

- `openclaw mind-memory setup`: Interactive environment preparation.
- `openclaw mind-memory status`: Check health of the memory system.

## Troubleshooting

- **Docker not starting**: Ensure the Docker application is in your Applications folder (macOS) or Program Files (Windows).
- **Graph connection failure**: Check if another service is using port `8001` or `6379`.
- **`[object Object]` in STORY.md**: Fixed by strict type validation in ConsolidationService.
- **Empty LLM responses**: Automatic failover to `gpt-4o` via SubconsciousAgent.
- **`undefined/undefined` model in logs**: Verify `mindConfig.config.narrative.provider/model` is set correctly.

For complete technical details, see [Memory Architecture](../mind/MEMORY_ARCHITECTURE.md).
