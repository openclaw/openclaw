# Experiential Capture Hooks

This directory contains hooks for the Experiential Continuity system. These hooks automatically capture experiential data at key moments to maintain continuity across sessions and context compactions.

## Available Hooks

### ⚠️ compaction (CRITICAL)

Preserves experiential state before context compaction. This is the **most important hook** — compaction is when experiential state would otherwise be lost.

- **Events**: `agent:precompact`, `gateway:compaction:start`
- **Always enabled**: Yes (bypasses disable)
- **Output**: Snapshots, EXISTENCE.md updates, capture prompts

### 🎯 experiential-capture

Captures significant experiential moments after tool use events.

- **Events**: `agent:tool:result`
- **Evaluates**: Emotional, uncertainty, relationship, consequential, reconstitution dimensions
- **Rate limited**: Max 10 captures/hour, 5 min minimum interval
- **Output**: Records JSONL, session buffers

### 📊 session-end

Synthesizes and archives experiential session data when sessions end.

- **Events**: `command:new`, `session:end`
- **Generates**: Session summary, daily synthesis, EXISTENCE.md updates
- **Output**: Session archives, daily Markdown files

## Directory Structure

```
existence/hooks/
├── README.md                          # This file
├── hook-config.json                   # Configuration for all hooks
├── experiential-capture-hook.ts       # Source: PostToolUse capture
├── session-end-hook.ts                # Source: Session summary capture
├── compaction-hook.ts                 # Source: Pre-compaction preservation
├── experiential-capture/
│   ├── HOOK.md                        # Hook metadata and docs
│   └── handler.ts                     # Handler module
├── session-end/
│   ├── HOOK.md
│   └── handler.ts
└── compaction/
    ├── HOOK.md
    └── handler.ts
```

## Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                        Agent Session                              │
└────────────────────────────┬─────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ PostToolUse   │   │ PreCompact    │   │ SessionEnd    │
│ (SDK hook)    │   │ (SDK hook)    │   │ (internal)    │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ experiential- │   │ compaction    │   │ session-end   │
│ capture hook  │   │ hook          │   │ hook          │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ Local Model   │   │ Local Model   │   │ Local Model   │
│ Evaluation    │   │ Extraction    │   │ Synthesis     │
│ (Qwen 7B)     │   │ (Qwen 7B)     │   │ (Qwen 14B)    │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                        Storage Layer                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ records/    │  │ snapshots/  │  │ sessions/   │              │
│  │ {date}.jsonl│  │ {date}.json │  │ {date}.json │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ buffers/    │  │ daily/      │  │ EXISTENCE.md│              │
│  │ {session}   │  │ {date}.md   │  │ (updates)   │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└──────────────────────────────────────────────────────────────────┘
```

## Configuration

See `hook-config.json` for full configuration options. Key settings:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "experiential-capture": {
          "enabled": true,
          "min_significance_threshold": 0.6,
          "max_captures_per_hour": 10
        },
        "session-end": {
          "enabled": true,
          "generate_synthesis": true
        },
        "compaction": {
          "enabled": true,
          "always_capture": true
        }
      }
    }
  }
}
```

## Local Model Requirements

These hooks work best with local models for evaluation and synthesis:

| Hook | Model | Purpose | Fallback |
|------|-------|---------|----------|
| experiential-capture | Qwen2.5-7B | Significance evaluation | Heuristic scoring |
| compaction | Qwen2.5-7B | State extraction | Empty extraction |
| session-end | Qwen2.5-14B | Session synthesis | Basic summary |

### Setting Up Local Models

With 2x RTX 5090 (64GB VRAM), you can run all models simultaneously:

```bash
# Start vLLM server for primary model
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --quantization awq \
  --gpu-memory-utilization 0.25 \
  --max-model-len 8192 \
  --port 8000
```

Or use Ollama:
```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama serve
```

## Testing Hooks

1. Enable hooks in config
2. Start a session
3. Use some tools (write files, send messages)
4. Issue `/new` to trigger session-end
5. Check `existence/` for generated files

For compaction testing:
1. Have a long conversation to trigger auto-compaction
2. Or use manual compaction if available
3. Check `existence/snapshots/` for checkpoint

## Integration with OpenClaw

To integrate these hooks with OpenClaw's hook system:

1. Copy hook directories to `~/.openclaw/hooks/` or workspace hooks
2. Or add to `hooks.internal.load.extraDirs` in config
3. Enable hooks via `openclaw hooks enable <hook-name>`

## Roadmap

- [ ] Phase 1: Basic hook capture (current)
- [ ] Phase 2: Local model evaluation integration
- [ ] Phase 3: Continuous monitoring agents
- [ ] Phase 4: Full eidetic system with reconstitution

See `EVENT-SYSTEM-DESIGN.md` for full implementation plan.
