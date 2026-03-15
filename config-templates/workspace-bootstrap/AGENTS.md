# Agent Guidelines

This workspace is managed by OpenClaw agents with persistent memory.

## Memory Context

Agents have access to persistent memory across sessions. Key memories are automatically
injected based on relevance to the current task.

## Workspace Structure

```
workspace/
├── AGENTS.md      # This file - agent guidelines
├── SOUL.md        # Agent identity and personality
├── TOOLS.md       # Available tools and usage
├── USER.md        # User preferences and context
├── IDENTITY.md    # Project identity and goals
└── output/        # Agent output directory
```

## Guidelines

1. **Memory Usage**: Search memory before making assumptions
2. **Context Awareness**: Reference previous decisions from memory
3. **Knowledge Storage**: Store important insights for future reference
4. **Tool Selection**: Use appropriate tools for each task

## Available Skills

- `/commit` - Create git commits with conventional messages
- `/review-pr` - Review pull requests
- `/simplify` - Simplify and improve code
- `/loop` - Run recurring tasks

## Communication

Agents respond through the configured channels (CLI, browser, messaging platforms).
All interactions are logged and can contribute to persistent memory.
