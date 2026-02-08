# @openclaw/core-memories

Hierarchical memory system for OpenClaw agents with progressive compression and event-driven retrieval.

## Overview

CoreMemories addresses the need for efficient, context-aware memory in AI agents. Instead of loading entire memory files at session start, it uses a triggered retrieval system that loads only relevant memories when needed.

## Quick Start

```javascript
import { getCoreMemories } from "@openclaw/core-memories";

const cm = await getCoreMemories();

// Add a memory
cm.addFlashEntry("User wants to build voice system", "user");

// Find memories by keyword
const results = cm.findByKeyword("voice");

// Load session context (default startup)
const { flash, warm, totalTokens } = cm.loadSessionContext();
```

## Features

- **3-layer architecture**: Hot (Flash/Warm), Recent, Archive
- **Progressive compression**: Detail fades with age like human memory
- **Event-driven retrieval**: Load memories only when keywords match
- **Token efficiency**: ~18% reduction vs loading full MEMORY.md
- **Local-first**: Works offline, optional API enhancement
- **MEMORY.md integration**: Proposes important memories for curated biography

## Architecture

See [docs/architecture.md](docs/architecture.md) for complete system overview.

## Configuration

Zero configuration by default. Auto-detects local LLM (Ollama) or falls back to rule-based compression.

```json
{
  "coreMemories": {
    "enabled": true,
    "compression": "auto"
  }
}
```

## Documentation

- [Specification](docs/spec.md) - Full technical specification
- [Architecture](docs/architecture.md) - System architecture and data flows
- [Integration Guide](../../docs/memory/core-memories-integration.md) - HEARTBEAT and CRON integration

## Testing

```bash
npm test
```

## License

MIT - See [LICENSE](../../LICENSE)
