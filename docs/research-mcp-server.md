# Research Assistant MCP Server

Model Context Protocol (MCP) integration for the research chatbot, enabling Claude and other AI assistants to interact with research documents.

## Quick Start

### 1. Start the MCP Server

```bash
# Compile TypeScript
pnpm build

# Start MCP server on stdio
node dist/lib/research-mcp-server.js
```

The server listens on stdin/stdout using JSON-RPC protocol, compatible with MCP clients.

### 2. Connect via Claude (Desktop or Web)

Add to Claude's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openclaw-research": {
      "command": "node",
      "args": ["/path/to/dist/lib/research-mcp-server.js"]
    }
  }
}
```

Then in Claude, you can:

```
Create a research document about our quarterly review process.
Add this note: "We need better feedback mechanisms for remote employees."
Show me what we have so far.
Export as markdown.
```

### 3. Use with mcporter (CLI)

If you have `mcporter` installed:

```bash
# List available tools
mcporter list openclaw-research

# Call a tool
mcporter call openclaw-research.research_create_session title="My Research"
mcporter call openclaw-research.research_add_message sessionId=research-xxx content="Initial notes"
mcporter call openclaw-research.research_export sessionId=research-xxx format=markdown
```

## Available Tools

### `research_create_session`

Create a new research session.

**Input:**

```json
{
  "title": "Research title",
  "summary": "Optional one-liner",
  "template": "brief|design|postmortem"
}
```

**Output:**

```json
{
  "ok": true,
  "sessionId": "research-1708282400000-abc123",
  "message": "Created session \"Research title\" (...)"
}
```

### `research_add_message`

Add a user message and get assistant response.

**Input:**

```json
{
  "sessionId": "research-1708282400000-abc123",
  "content": "Add this note about requirements..."
}
```

**Output:**

```json
{
  "ok": true,
  "sessionId": "research-1708282400000-abc123",
  "assistantResponse": "Great! I've noted that...",
  "turns": 2,
  "sections": 3
}
```

### `research_show_document`

Display current research document.

**Input:**

```json
{
  "sessionId": "research-1708282400000-abc123"
}
```

**Output:**

```json
{
  "ok": true,
  "sessionId": "research-1708282400000-abc123",
  "document": "# Research Title\n\n**Summary:** ...\n\n## Section 1\n...",
  "sectionCount": 3
}
```

### `research_export`

Export document in Markdown or JSON.

**Input:**

```json
{
  "sessionId": "research-1708282400000-abc123",
  "format": "markdown|json"
}
```

**Output:**

```json
{
  "ok": true,
  "sessionId": "research-1708282400000-abc123",
  "format": "markdown",
  "content": "# Research Title\n..."
}
```

### `research_list_sessions`

List all active sessions.

**Input:**

```json
{}
```

**Output:**

```json
{
  "ok": true,
  "count": 2,
  "sessions": [
    {
      "sessionId": "research-1708282400000-abc123",
      "title": "Research Title",
      "summary": "Summary text",
      "sections": 3,
      "turns": 5,
      "createdAt": 1708282400000,
      "updatedAt": 1708282410000
    }
  ]
}
```

### `research_apply_suggestion`

Apply suggested changes to document.

**Input:**

```json
{
  "sessionId": "research-1708282400000-abc123",
  "suggestion": "## New Section\n\nSuggested content here..."
}
```

**Output:**

```json
{
  "ok": true,
  "sessionId": "research-1708282400000-abc123",
  "message": "Applied suggestion. Document now has 4 sections."
}
```

## JSON-RPC Protocol

All communication uses JSON-RPC 2.0 over stdio.

### Request Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "research_create_session",
    "arguments": {
      "title": "Research Title"
    }
  }
}
```

### Response Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "ok": true,
    "sessionId": "research-..."
  }
}
```

### Error Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "Method not found"
  }
}
```

## Architecture

### Core Components

1. **Session Management** (`research-chatbot.ts`)
   - Create sessions with unique IDs
   - Maintain conversation history
   - Manage document state

2. **Tool Handler** (`research-mcp-server.ts`)
   - Route incoming tool calls
   - Validate parameters
   - Return structured responses

3. **Response Generator** (heuristic in Phase 1)
   - Generate contextual responses
   - Apply suggestions to documents
   - Export in multiple formats

### Data Flow

```
Claude Input
    ↓
JSON-RPC Message (stdin)
    ↓
Tool Router (handleToolCall)
    ↓
Session Store + Research Logic
    ↓
JSON Response (stdout)
    ↓
Claude Output
```

## Phase 1 vs Phase 2

### Phase 1 (Current)

- ✅ MCP server skeleton with all 6 tools
- ✅ Heuristic-based assistant responses
- ✅ In-memory session storage
- ✅ Markdown/JSON export
- ✅ Compatible with standard MCP clients

### Phase 2 (Planned)

- 🤖 LLM-powered responses via agent runtime
- 💾 Persistent session storage (filesystem or DB)
- 📊 Advanced section extraction
- 🔄 Multi-turn conversation memory
- ⚡ Streaming responses
- 🌐 Web UI integration

## Testing

### Manual Test with jq

```bash
# Start server in one terminal
node dist/lib/research-mcp-server.js

# In another terminal, test via stdin
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | node dist/lib/research-mcp-server.js

# Or test specific tool
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"research_list_sessions","arguments":{}}}' | \
  node dist/lib/research-mcp-server.js
```

### Automated Tests

```bash
# Run MCP integration tests (Phase 2)
pnpm test src/lib/research-mcp-server.test.ts
```

## Configuration

### Environment Variables

- `DEBUG=openclaw:research:mcp` – Enable verbose logging
- `MCP_LOG_LEVEL=debug|info|warn|error` – Log level

### Server Options

Currently none (Phase 1). Phase 2 will add:

- Session storage backend
- Model selection for LLM responses
- Custom system prompts
- Rate limiting

## Troubleshooting

### "Invalid JSON" errors

Ensure each message is on a single line (newline-delimited JSON).

### Sessions not persisting

Phase 1 uses in-memory storage. Restart server to clear sessions. Phase 2 will add persistent storage.

### Claude can't find tool

Verify `claude_desktop_config.json` points to correct path and server is running.

## Related Files

- [src/lib/research-chatbot.ts](src/lib/research-chatbot.ts) – Core session logic
- [src/cli/research-chat-interactive.ts](src/cli/research-chat-interactive.ts) – CLI integration
- [docs/research-assistant-chatbot.md](docs/research-assistant-chatbot.md) – User guide
- [RESEARCH_CHATBOT_IMPLEMENTATION.md](RESEARCH_CHATBOT_IMPLEMENTATION.md) – Implementation details
