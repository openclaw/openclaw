# Research Assistant Chatbot

Interactive LLM-powered research assistant for structuring and refining your work.

## Quick Start

Start the interactive chatbot mode:

```bash
openclaw research --chat
```

This launches an interactive conversation where you can:

- Enter research notes and ideas
- Get AI suggestions for structuring and refinement
- Iteratively build your research document
- Export as Markdown or JSON

## Features

### 1. **Interactive Chat Mode** (`--chat`)

Start a multi-turn conversation with the research assistant:

```bash
openclaw research --chat --template brief
```

You control the conversation flow:

- **Type notes/questions** → Assistant provides suggestions
- **Use commands** → `/show`, `/export`, `/help`, `/done`
- **Refine iteratively** → Ask clarifying questions, iterate on sections

### 2. **Templates**

Start from a predefined template structure:

```bash
openclaw research --chat --template brief      # One-pager
openclaw research --chat --template design     # Detailed design doc
openclaw research --chat --template postmortem # Incident postmortem
```

Templates are defined in [research-templates.md](research-templates.md).

### 3. **Export Options**

Export your final research document:

```bash
# Interactive export (choose format in chat)
openclaw research --chat --output research.md

# Batch mode: from existing notes
openclaw research --from-file notes.md --output research.md
openclaw research --from-file notes.md --sectioned --output research.md
```

Formats:

- **Markdown** (`.md`) – Human-readable, shareable
- **JSON** (`.json`) – Structured, machine-parseable
- **Both** – Export both formats in one command

## Commands (in chat mode)

| Command   | Effect                               |
| --------- | ------------------------------------ |
| `/show`   | Display current research document    |
| `/export` | Save and export research             |
| `/done`   | Finish and export (alias: `/export`) |
| `/help`   | Show available commands              |

## Phase 1 vs Phase 2

### Phase 1 (Current – Heuristic)

- ✅ Deterministic heading/heuristic section extraction
- ✅ Interactive multi-turn chat flow
- ✅ Heuristic responses (template-based suggestions)
- ✅ Export to Markdown/JSON
- ✅ Command handling (`/show`, `/export`, etc.)

### Phase 2 (Future – LLM-Powered)

Planned enhancements:

1. **LLM-powered assistant responses** – Real Claude/GPT suggestions
   - Smart clarifying questions
   - Intelligent section refinement
   - Content generation from user notes

2. **Advanced extraction** – LLM parses unstructured input
   - Hybrid heading-split + LLM fallback
   - Structured JSON extraction

3. **Multi-turn reasoning** – LLM context preserved
   - Conversation memory
   - Section cross-referencing
   - Iterative refinement

4. **Web UI** – Conversational interface beyond CLI
   - Browser-based chat
   - Live preview
   - Collaborative editing (future)

5. **Channel integration** – Bring chatbot to messaging apps
   - Discord: `!research chat`
   - Slack: `/openclaw research`
   - Telegram: Direct conversation

## Architecture

### Core Types

```typescript
// Session: ongoing research conversation
type ResearchChatSession = {
  sessionId: string;
  turns: ResearchChatTurn[]; // User + Assistant messages
  workingDoc: ResearchDoc; // Current research document
  template?: string;
  createdAt: number;
  updatedAt: number;
};

// Document: structured research output
type ResearchDoc = {
  title: string;
  summary?: string;
  sections: Section[]; // Sections with titles + text
  template?: string;
  provenance: { method: "headings" | "heuristic" | "llm" };
  schemaVersion: "research.v1";
};
```

### Modules

- **`src/lib/research-chatbot.ts`** – Core chatbot logic
  - `createResearchChatSession()` – Initialize session
  - `addChatTurn()` – Add user/assistant message
  - `buildResearchChatContext()` – Build LLM context
  - `applyResearchSuggestions()` – Parse and update document
  - `exportResearchDoc()` – Markdown/JSON export

- **`src/cli/research-chat-interactive.ts`** – CLI interaction
  - `runInteractiveResearchChat()` – Main chat loop
  - `generateResearchAssistantResponse()` – Heuristic responses
  - `handleExport()` – Export dialog

- **`src/cli/register.research.ts`** – CLI command registration
  - `--chat` flag → Launch chatbot
  - `--wizard` flag → Lightweight wizard
  - `--template` → Start from template

## Roadmap

1. ✅ **Phase 1** – Heuristic research assistant (current)
2. **Phase 2** – LLM-powered suggestions (Claude/GPT)
3. **Phase 3** – Web UI chatbot dashboard
4. **Phase 4** – Channel plugins (Discord, Slack, etc.)
5. **Phase 5** – Collaborative editing + sharing

## Integration with Agent System

To integrate with the main agent runtime for Phase 2:

```typescript
// In research-chatbot.ts (Phase 2 enhancement)
import { runEmbeddedPiAgent } from "../agents/pi-embedded-runner.js";

async function generateLlmResponse(
  userInput: string,
  context: ResearchChatContext,
  defaultModel?: string,
): Promise<string> {
  const result = await runEmbeddedPiAgent({
    systemPrompt: context.systemPrompt,
    userMessages: [{ role: "user", content: userInput }],
    priorMessages: context.conversationHistory,
    model: defaultModel,
  });

  return extractContentFromMessage(result.finalMessage);
}
```

## Examples

### Example 1: Quick Research Brief

```bash
$ openclaw research --chat --template brief

What is your research about?
> Performance investigation for Q1 2026

One-line summary (optional):
> Database query latency drops 30% under load

You:
> We're seeing p99 latency spike to 500ms when concurrency > 100.
> Happens every weekend. Pool exhaustion suspected.
```
