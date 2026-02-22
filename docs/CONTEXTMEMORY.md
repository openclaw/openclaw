# ContextMemory Integration Guide

This guide explains how OpenClaw contributors can optionally use ContextMemory to persist development context across AI-assisted coding sessions.

## Overview

ContextMemory is a CLI tool that helps developers save and restore their working context, including:

- Current task
- Goals and decisions
- Implementation progress
- Next planned steps

This can be useful when working with AI coding assistants such as ChatGPT, Claude, or Cursor, allowing contributors to resume work without manually reconstructing project context.

ContextMemory does not modify OpenClaw source code and is entirely optional.

---

## Installation

Install ContextMemory globally using npm:

```bash
npm install -g @akashkobal/contextmemory
```

Verify installation:

```bash
contextmemory --help
```

---

## Initialize in OpenClaw Repository

From the OpenClaw project root directory:

```bash
contextmemory init
```

This creates a `.contextmemory/` directory used to store development context locally.

Example structure:

```
.contextmemory/
├── context.json
├── history/
```

This directory is local to your development environment.

---

## Saving Development Context

To save your current OpenClaw development state:

```bash
contextmemory save "Working on OpenClaw feature implementation"
```

This records relevant information such as:

- Task description  
- Current progress  
- Development decisions  
- Next steps  

You can update context at any time during development.

---

## Resuming Development Context

To restore previously saved context:

```bash
contextmemory resume
```

This copies a formatted context summary to your clipboard.

You can paste it into your AI coding assistant to restore development continuity.

---

## Optional MCP Integration

If using an MCP-compatible AI tool, add the following configuration:

```json
{
  "mcpServers": {
    "contextmemory": {
      "command": "npx",
      "args": ["-y", "@akashkobal/contextmemory", "mcp"]
    }
  }
}
```

This allows compatible tools to access stored context automatically.

---

## Example Use Cases in OpenClaw Development

ContextMemory may be useful for:

- Large feature development  
- Multi-session contributions  
- Refactoring tasks  
- AI-assisted debugging  
- Tracking architectural decisions  

---

## Notes

- ContextMemory is optional  
- It does not change OpenClaw functionality  
- It stores context locally in your development environment  
- It can be safely ignored if not needed  

---

## Related Links

- npm package: https://www.npmjs.com/package/@akashkobal/contextmemory  
- Source repository: https://github.com/AkashKobal/contextmemory
