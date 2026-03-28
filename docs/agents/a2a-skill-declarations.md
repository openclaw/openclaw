# A2A Skill Declarations

Agent-to-Agent (A2A) skill declarations allow agents to advertise their capabilities to other agents in a structured, machine-readable format.

## Overview

When agents declare their skills, the A2A system can:

1. **Validate skill availability** before calling an agent
2. **Provide helpful error messages** when requesting unsupported skills
3. **Route requests intelligently** based on declared capabilities
4. **Enable discovery** of agent capabilities across the network

## Configuration

### Declaring Skills in Agent Configuration

Skills are declared in the agent's configuration file or via the `agents` config section:

```yaml
agents:
  metis:
    declaredSkills:
      skills:
        - name: research
          description: "Deep research on any topic with source citations"
          inputSchema:
            type: object
            properties:
              query:
                type: string
                description: "The research question or topic"
              depth:
                type: string
                enum: ["quick", "standard", "deep"]
            required: ["query"]
          outputSchema:
            type: object
            properties:
              answer:
                type: string
              sources:
                type: array
                items:
                  type: string
              confidence:
                type: number
                minimum: 0
                maximum: 1

        - name: critique
          description: "Critical analysis of arguments, claims, or proposals"
          inputSchema:
            type: object
            properties:
              content:
                type: string
                description: "Content to critique"
              perspective:
                type: string
                description: "Critical perspective to apply"
            required: ["content"]
          outputSchema:
            type: object
            properties:
              strengths:
                type: array
                items:
                  type: string
              weaknesses:
                type: array
                items:
                  type: string
              confidence:
                type: number

        - name: refine
          description: "Refine and improve content based on feedback"
          inputSchema:
            type: object
            properties:
              content:
                type: string
              feedback:
                type: string
              focus:
                type: string
                description: "What aspect to focus improvement on"
            required: ["content", "feedback"]
```

### JSON Schema Format

Each skill declaration follows this structure:

```typescript
interface SkillDeclaration {
  name: string; // Skill identifier (e.g., "research", "critique")
  description?: string; // Human-readable description
  inputSchema?: JSONSchema; // JSON Schema for input validation
  outputSchema?: JSONSchema; // JSON Schema for output validation
}
```

## Using A2A Tools

### agent_call

Call another agent's skill with structured I/O:

```typescript
const result = await agent_call({
  agent: "metis",
  skill: "research",
  input: {
    query: "What are the implications of quantum computing for cryptography?",
    depth: "deep",
  },
  mode: "execute", // "execute" | "critique"
  timeoutSeconds: 300,
});
```

### debate_call

Orchestrate a multi-agent debate:

```typescript
const result = await debate_call({
  topic: "Should we adopt microservices architecture?",
  proposer: {
    agent: "main",
    skill: "propose",
  },
  critics: [
    { agent: "metis", skill: "critique", perspective: "maintenance burden" },
    { agent: "hephaestus", skill: "critique", perspective: "security" },
  ],
  resolver: {
    agent: "main",
    skill: "synthesize",
  },
  input: {
    context: "Current monolith has 50 services...",
  },
});
```

## Skill Discovery

### Checking if an agent has a skill

```typescript
import {
  hasDeclaredSkill,
  getDeclaredSkill,
} from "@openclaw/agents/tools/a2a-skill-declaration.js";

if (hasDeclaredSkill("metis", "research", config)) {
  const skill = getDeclaredSkill("metis", "research", config);
  console.log(skill.description);
  // "Deep research on any topic with source citations"
}
```

### Listing all skills for an agent

```typescript
import { listDeclaredSkills } from "@openclaw/agents/tools/a2a-skill-declaration.js";

const skills = listDeclaredSkills("metis", config);
// [
//   { name: "research", description: "..." },
//   { name: "critique", description: "..." },
//   { name: "refine", description: "..." }
// ]
```

## Error Handling

When calling an agent without the requested skill:

```typescript
const result = await agent_call({
  agent: "main",
  skill: "nonexistent"
});

// Result:
{
  status: "error",
  error: "Agent 'main' has no declared skill 'nonexistent'. Available skills: consult, collaborate, ping."
}
```

## Best Practices

1. **Be specific in skill names** - Use clear, verb-based names like `research`, `critique`, `refine`
2. **Include descriptions** - Help other agents understand what each skill does
3. **Define schemas** - Input/output schemas enable validation and better error messages
4. **Keep skills focused** - Each skill should do one thing well
5. **Document assumptions** - Use schema descriptions to clarify expected inputs

## A2A Cache Configuration

The A2A result cache can be configured in `agents.defaults`:

```json
{
  "agents": {
    "defaults": {
      "a2aCache": {
        "cleanupIntervalMs": 60000,
        "defaultTtlMs": 60000,
        "maxTtlMs": 3600000,
        "maxSize": 10000
      }
    }
  }
}
```

### Cache Configuration Options

| Option              | Default | Description                                   |
| ------------------- | ------- | --------------------------------------------- |
| `cleanupIntervalMs` | 60000   | How often to clean expired entries (1 minute) |
| `defaultTtlMs`      | 60000   | Default time-to-live for cached results       |
| `maxTtlMs`          | 3600000 | Maximum allowed TTL (1 hour)                  |
| `maxSize`           | 10000   | Maximum entries before LRU eviction           |

## Monitoring

Get cache statistics for health monitoring:

```typescript
import { getA2ACacheMetrics } from "@openclaw/infra/a2a-result-cache.js";

const metrics = getA2ACacheMetrics();
console.log({
  size: metrics.size, // Current entries
  maxSize: metrics.maxSize, // Maximum capacity
  hitRate: metrics.hitRate, // Cache hit rate (0-1)
  hits: metrics.hits, // Total cache hits
  misses: metrics.misses, // Total cache misses
  evictions: metrics.evictions, // LRU evictions count
});
```

## Error Codes

A2A errors use typed error codes:

```typescript
enum A2AErrorCode {
  NOT_ENABLED = "A2A_NOT_ENABLED",
  AGENT_NOT_ALLOWED = "A2A_AGENT_NOT_ALLOWED",
  SELF_CALL_BLOCKED = "A2A_SELF_CALL_BLOCKED",
  CACHE_MISS = "A2A_CACHE_MISS",
  CACHE_TIMEOUT = "A2A_CACHE_TIMEOUT",
  AGENT_ERROR = "A2A_AGENT_ERROR",
  EMPTY_RESPONSE = "A2A_EMPTY_RESPONSE",
  INVALID_INPUT = "A2A_INVALID_INPUT",
  SESSION_NOT_FOUND = "A2A_SESSION_NOT_FOUND",
}
```

## See Also

- [Agent Configuration Guide](./agent-configuration.md)
- [A2A Protocol Specification](./a2a-protocol.md)
- [Debate Call Patterns](./debate-patterns.md)
