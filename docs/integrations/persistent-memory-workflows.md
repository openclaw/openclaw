---
summary: "Setting up Claude-based persistent memory workflows with OpenClaw"
read_when:
  - Configuring persistent memory for AI assistants
  - Setting up long-running project contexts
  - Enabling knowledge retention across sessions
title: "Persistent Memory Workflows"
---

# Persistent Memory Workflows

This guide explains how to set up OpenClaw for persistent memory workflows with Claude, enabling context retention and knowledge accumulation across sessions.

## Overview

Persistent memory workflows allow your AI assistant to:

- **Remember** important information across sessions
- **Learn** your preferences and working patterns
- **Maintain** project context over time
- **Recall** previous decisions and their reasoning

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Code / Desktop                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ MCP Protocol
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw MCP Server                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Memory Tools │  │ Session Mgmt │  │ Skill Exec   │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP API
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Agent Runtime│  │ QMD Memory   │  │ Session Store│       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Persistent Storage                        │
│  ~/.openclaw/                                                │
│  ├── workspace/          (Agent workspace)                  │
│  ├── agents/             (Session transcripts)              │
│  ├── knowledge/          (Indexed knowledge base)           │
│  └── memory-exports/     (Exported session context)         │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install Configuration

Use the provided configuration template:

```bash
# Copy configuration
cp config-templates/claude-persistent-memory.json5 ~/.openclaw/openclaw.json

# Copy workspace bootstrap files
mkdir -p ~/.openclaw/workspace
cp -r config-templates/workspace-bootstrap/* ~/.openclaw/workspace/

# Initialize
openclaw setup
```

### 2. Configure MCP Client

Add OpenClaw to your Claude Code configuration:

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "openclaw",
      "args": ["mcp", "serve"]
    }
  }
}
```

### 3. Start the Gateway

```bash
openclaw gateway run --bind loopback --port 18789
```

### 4. Verify Setup

```bash
# Check gateway status
openclaw channels status --probe

# Test memory
openclaw memory status
```

## Memory System

### Storage Modes

OpenClaw supports multiple memory storage backends:

| Backend | Use Case | Features |
|---------|----------|----------|
| `qmd` | Full-featured | Vector search, embeddings, temporal decay |
| `sqlite` | Simple | Keyword search, fast queries |
| `file` | Minimal | JSON file storage |

### Vector Search

The QMD backend enables semantic search using embeddings:

```json5
{
  memory: {
    backend: "qmd",
    qmd: {
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small"
      }
    }
  }
}
```

### Search Modes

- **`search`** - Keyword-based full-text search
- **`vsearch`** - Vector similarity search (semantic)
- **`query`** - Natural language query interpretation

### Temporal Decay

Recent memories can be weighted higher:

```json5
{
  memory: {
    retrieval: {
      temporalDecay: {
        enabled: true,
        halfLifeDays: 30  // Memories half as relevant after 30 days
      }
    }
  }
}
```

## Workflow Patterns

### Session Start Pattern

At the beginning of each session, retrieve relevant context:

```typescript
// Search for recent project context
const projectContext = await mcp.call("openclaw_memory_search", {
  query: "project status and recent decisions",
  mode: "vsearch",
  limit: 5
});

// Search for user preferences
const preferences = await mcp.call("openclaw_memory_search", {
  query: "user preferences and working style",
  mode: "vsearch",
  limit: 3
});
```

### Decision Recording Pattern

Store important decisions with context:

```typescript
await mcp.call("openclaw_memory_add", {
  content: `
    Decision: Use PostgreSQL for the new service
    Reasoning: Need JSONB support, team familiarity, existing infrastructure
    Alternatives considered: MongoDB (rejected: consistency needs), MySQL (rejected: JSON support)
    Date: ${new Date().toISOString()}
  `,
  metadata: {
    type: "decision",
    project: "new-service",
    confidence: "high",
    stakeholders: ["engineering", "ops"]
  }
});
```

### Learning Pattern

Accumulate knowledge over time:

```typescript
// After completing research
await mcp.call("openclaw_memory_add", {
  content: `
    Finding: The auth service uses JWT with RS256 signing
    Location: src/auth/jwt.ts
    Related: User model in src/models/user.ts
  `,
  metadata: {
    type: "finding",
    domain: "authentication",
    source: "code-exploration"
  }
});
```

### Preference Learning Pattern

Store and reference user preferences:

```typescript
// When user expresses a preference
await mcp.call("openclaw_memory_add", {
  content: "User prefers descriptive variable names over short abbreviations",
  metadata: {
    type: "preference",
    category: "code-style",
    strength: "strong"
  }
});

// When making decisions
const preferences = await mcp.call("openclaw_memory_search", {
  query: "code style preferences",
  mode: "vsearch"
});
// Apply preferences to code generation
```

## Workspace Configuration

### Bootstrap Files

Configure the agent's behavior through workspace files:

#### AGENTS.md
Operating instructions and memory guidelines. Defines when and how to use the memory system.

#### SOUL.md
Agent persona, communication style, and boundaries. Sets the tone for interactions.

#### TOOLS.md
Tool usage notes and best practices. Guides tool selection and usage patterns.

#### USER.md
User profile and preferences. Customize this for your specific needs.

### Example USER.md

```markdown
# User Profile

## Preferences
- Preferred language: TypeScript with strict mode
- Code style: Functional patterns where appropriate
- Testing: Jest with high coverage expectations
- Communication: Concise, technical explanations

## Projects
- main-app: React frontend, Node backend
- data-pipeline: Python ETL scripts
- infra: Terraform configurations

## Context
- Work environment: VS Code with vim keybindings
- Common tasks: Feature development, code review, debugging
- Tools: pnpm, Docker, GitHub Actions
```

## Advanced Configuration

### Multi-Project Memory

Organize memories by project:

```json5
{
  memory: {
    qmd: {
      paths: [
        // Global knowledge
        {
          path: "~/.openclaw/knowledge/global",
          patterns: ["**/*"]
        },
        // Project-specific
        {
          path: "~/.openclaw/knowledge/project-a",
          patterns: ["**/*"]
        },
        {
          path: "~/.openclaw/knowledge/project-b",
          patterns: ["**/*"]
        }
      ]
    }
  }
}
```

### Memory Retention Policies

Configure how long memories persist:

```json5
{
  memory: {
    retention: {
      // Default retention (days, 0 = forever)
      default: 0,

      // Type-specific retention
      byType: {
        decision: 365,    // Keep decisions for a year
        finding: 90,      // Findings expire after 90 days
        preference: 0     // Preferences never expire
      }
    }
  }
}
```

### Session Export

Export session transcripts to memory:

```json5
{
  memory: {
    qmd: {
      sessions: {
        exportDir: "~/.openclaw/memory-exports",
        exportOnSessionEnd: true,
        includeToolCalls: false  // Exclude tool outputs
      }
    }
  }
}
```

## Best Practices

### Memory Hygiene

1. **Be specific** - Store atomic, searchable facts
2. **Include context** - Add metadata for better retrieval
3. **Update outdated info** - Mark superseded decisions
4. **Review periodically** - Clean up irrelevant memories

### Effective Searches

1. **Use semantic search** - `vsearch` for conceptual queries
2. **Limit results** - Don't overwhelm context with too many memories
3. **Combine modes** - Use keyword search for specific terms
4. **Check recency** - Recent memories may be more relevant

### Security Considerations

1. **Sensitive data** - Tag and handle appropriately
2. **Access control** - Use agent-specific memory spaces
3. **Encryption** - Consider encrypted storage for sensitive projects
4. **Audit** - Review stored memories for compliance

## Troubleshooting

### Memories Not Found

```bash
# Check memory status
openclaw memory status

# Verify indexing
openclaw memory reindex

# Test search
openclaw memory search "test query"
```

### Slow Memory Queries

Enable mcporter for faster queries:

```json5
{
  memory: {
    qmd: {
      mcporter: {
        enabled: true,
        startDaemon: true
      }
    }
  }
}
```

### Memory Overflow

If memory grows too large:

```bash
# Check memory size
openclaw memory stats

# Clean old entries
openclaw memory prune --older-than 90d
```

---

_See also: [MCP Integration](/integrations/mcp), [Claude Code Subagents](/integrations/claude-code-subagents)_
