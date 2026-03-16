# @openclaw/rag

Local RAG (Retrieval-Augmented Generation) pipeline for OpenClaw workspaces. Automatically indexes your skills, memories, and reference files, then injects the most relevant ones into the model's system prompt based on semantic similarity to the user's message.

## The Problem

OpenClaw workspaces accumulate a lot of context — skill definitions, reference docs, daily memories, project-specific knowledge. The agent can only load a few of these into its system prompt at a time, so it often misses relevant context unless you explicitly tell it which file to read. This means you end up saying things like "read the smart-qa-reference.md first" instead of the agent just *knowing* it's relevant.

## How It Works

```
User message arrives
        │
        ▼
┌─────────────────┐
│  Embed query     │  Xenova/all-MiniLM-L6-v2 (runs locally, ~384 dims)
│  with local model│  No API calls, no external services
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Vector search   │  SQLite + sqlite-vec (L2 distance → cosine similarity)
│  against index   │  Pre-chunked by H2 headings for large files
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Threshold filter│  Default: cosine similarity ≥ 0.35
│  + token cap     │  Default: ≤ 8000 tokens injected (~32KB)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Load full files │  If a chunk matches, the ENTIRE source file is injected
│  & inject into   │  (not just the matching chunk — preserves full context)
│  system prompt   │
└─────────────────┘
```

**Key design decisions:**
- **Full-file injection**: When a chunk matches, we inject the entire source file. Skills and reference docs are written to be read as a whole; injecting a fragment loses critical context.
- **Local embeddings**: Uses `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers`. Runs entirely on-device — no API keys, no network calls, no cost.
- **SQLite + sqlite-vec**: Zero-dependency vector search. No Pinecone, no Chroma, no server. Just a single `.sqlite` file.
- **Incremental indexing**: Only re-embeds files whose content hash has changed. Full reindex of ~70 chunks takes ~10s; incremental updates are instant.

## Setup

```bash
cd packages/rag
npm install
node setup.js     # creates ~/.openclaw/rag/config.json
node indexer.js    # builds the initial index
```

### Automatic Re-indexing (macOS)

Create a LaunchAgent to re-index when workspace files change:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>ai.openclaw.rag-indexer</string>

    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>/path/to/packages/rag/indexer.js</string>
    </array>

    <!-- Re-index when workspace files change -->
    <key>WatchPaths</key>
    <array>
      <string>~/.openclaw/workspace</string>
    </array>

    <!-- Also re-index every 5 minutes as a fallback -->
    <key>StartInterval</key>
    <integer>300</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>~/.openclaw/logs/rag-indexer.log</string>
    <key>StandardErrorPath</key>
    <string>~/.openclaw/logs/rag-indexer.err.log</string>
  </dict>
</plist>
```

Save to `~/Library/LaunchAgents/ai.openclaw.rag-indexer.plist` and load:

```bash
launchctl load ~/Library/LaunchAgents/ai.openclaw.rag-indexer.plist
```

For Linux, use a systemd user service or cron job with `inotifywait`.

## Testing Queries

```bash
# Basic query
node query-cli.js "how do I run smart qa tests"

# With custom threshold
node query-cli.js "check datadog dashboards" --threshold 0.4

# Limit results
node query-cli.js "deploy to production" --max 3
```

Output shows matched chunks with similarity scores and a preview of what would be injected.

## Configuration

`~/.openclaw/rag/config.json`:

```json
{
  "enabled": true,
  "similarityThreshold": 0.35,
  "maxInjectedTokens": 8000,
  "maxResults": 5,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "embeddingDims": 384,
  "workspaceRoot": "~/.openclaw/workspace",
  "dbPath": "~/.openclaw/rag/index.sqlite",
  "logPath": "~/.openclaw/logs/rag.log",
  "indexPaths": [
    "skills/*/SKILL.md",
    "skills/*/references/*.md",
    "memory/*.md",
    "MEMORY.md"
  ],
  "excludePatterns": []
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `similarityThreshold` | `0.35` | Minimum cosine similarity to include a result. Lower = more results, higher = stricter matching. 0.35 works well for skill/memory retrieval. |
| `maxInjectedTokens` | `8000` | Maximum tokens (~4 chars each) to inject into the system prompt. Prevents context window bloat. |
| `maxResults` | `5` | Maximum number of chunks to retrieve (before deduplication to full files). |
| `indexPaths` | see above | Glob patterns relative to `workspaceRoot`. Add your own patterns to index additional files. |
| `embeddingModel` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID. Can swap for any sentence-transformers model supported by transformers.js. |

## Integrating RAG Into Your Proxy / Middleware

The RAG engine is a standalone module. To integrate it into your API proxy or middleware, you need to:

1. **Extract the user message** from the request body
2. **Query the RAG index** with that message
3. **Inject matching files** into the system prompt
4. **Forward the modified request**

### Hook Pattern: HTTP Proxy Injection

Here's the pattern used in a Bedrock bearer-token proxy (the reference implementation):

```javascript
const rag = require('@openclaw/rag');
// or: const rag = require('./path/to/rag-query');

// --- On startup: pre-warm the embedding model ---
let ragReady = false;
rag.getEmbedder().then(() => { ragReady = true; });

// --- On each request ---
async function processWithRag(bodyBuf) {
  if (!ragReady) return bodyBuf; // model still loading, pass through

  const body = JSON.parse(bodyBuf.toString());

  // 1. Extract the last user message
  const userMsg = extractUserMessage(body);
  if (!userMsg || userMsg.length < 10) return bodyBuf;

  // 2. Search the RAG index
  const results = await rag.search(userMsg);
  if (results.length === 0) return bodyBuf;

  // 3. Load full files and truncate to token budget
  const config = rag.loadConfig();
  const files = rag.getFullFiles(results, config.workspaceRoot);

  const maxChars = config.maxInjectedTokens * 4;
  let totalChars = 0;
  const truncatedFiles = [];
  for (const file of files) {
    if (totalChars + file.content.length > maxChars) {
      if (truncatedFiles.length === 0) {
        truncatedFiles.push({ ...file, content: file.content.slice(0, maxChars) });
      }
      break;
    }
    totalChars += file.content.length;
    truncatedFiles.push(file);
  }

  // 4. Format and inject into system prompt
  const injection = rag.formatForInjection(truncatedFiles);
  if (!injection) return bodyBuf;

  injectIntoSystemPrompt(body, injection);
  return Buffer.from(JSON.stringify(body));
}
```

### Extracting the User Message

Different APIs format messages differently. Here's a handler that covers both the Anthropic Messages API and the Bedrock Converse API:

```javascript
function extractUserMessage(body) {
  if (!body.messages || !Array.isArray(body.messages)) return null;

  // Walk backwards to find the most recent user message
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const msg = body.messages[i];
    if (msg.role !== 'user') continue;

    // Plain string content
    if (typeof msg.content === 'string') return msg.content;

    // Array of content blocks
    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter(b => (
          b.type === 'text' ||                              // Messages API: { type: 'text', text: '...' }
          (!b.type && typeof b.text === 'string')           // Converse API: { text: '...' }
        ))
        .map(b => b.text);
      if (textParts.length > 0) return textParts.join(' ');
    }
  }
  return null;
}
```

### Injecting Into the System Prompt

The system prompt format also varies by API. This handles both:

```javascript
function injectIntoSystemPrompt(body, ragContext) {
  if (typeof body.system === 'string') {
    // Simple string system prompt (some API wrappers)
    body.system = body.system + '\n\n' + ragContext;

  } else if (Array.isArray(body.system)) {
    // Detect format from existing blocks
    const usesTypeField = body.system.some(b => b.type);
    if (usesTypeField) {
      // Messages API: { type: 'text', text: '...' }
      body.system.push({ type: 'text', text: ragContext });
    } else {
      // Converse API: { text: '...' }
      body.system.push({ text: ragContext });
    }

  } else {
    // No system prompt yet
    body.system = [{ text: ragContext }];
  }
}
```

### Other Integration Points

The proxy pattern above is the simplest approach, but you can also integrate RAG at other levels:

- **OpenClaw plugin/extension**: Hook into the gateway's request pipeline directly (if/when the gateway exposes middleware hooks)
- **Pre-prompt script**: Run `query-cli.js` in a shell hook and append results to a context file that your agent reads
- **MCP tool**: Expose RAG search as an MCP tool so the agent can query it on-demand (less automatic, but gives the agent control over when to search)

## How Indexing Works

The indexer processes markdown files from `indexPaths`:

1. **Hash check**: Computes SHA-256 of file content. Skips files whose hash hasn't changed since last index.
2. **Chunking**: Files ≤ 8KB are stored as a single chunk. Larger files are split on `## ` (H2) headings.
3. **Embedding**: Each chunk is embedded with the configured model (384-dim vectors by default).
4. **Storage**: Chunks and their embeddings go into SQLite. Vector search uses the `vec0` virtual table extension.

Re-indexing is idempotent and safe to run concurrently (SQLite WAL mode).

## Architecture

```
~/.openclaw/
├── workspace/                  # Your OpenClaw workspace (source of truth)
│   ├── skills/
│   │   ├── datadog/
│   │   │   ├── SKILL.md        ← indexed
│   │   │   └── references/
│   │   │       └── dashboards.md  ← indexed
│   │   └── jira/
│   │       └── SKILL.md        ← indexed
│   ├── memory/
│   │   ├── 2026-03-12.md       ← indexed
│   │   └── 2026-03-15.md       ← indexed
│   └── MEMORY.md               ← indexed
│
├── rag/
│   ├── config.json             # Your instance config
│   ├── index.sqlite            # Vector index (auto-generated)
│   ├── rag-query.js            # Query/search library
│   ├── indexer.js              # Indexer (run on schedule or file change)
│   ├── query-cli.js            # CLI for testing
│   └── glob-simple.js          # Minimal glob (no deps)
│
└── logs/
    ├── rag-indexer.log         # Indexer output
    └── rag.log                 # Injection log (what was injected when)
```

## Dependencies

All run locally with zero external service dependencies:

| Package | Purpose |
|---------|---------|
| `@huggingface/transformers` | Local embedding model inference (ONNX runtime) |
| `better-sqlite3` | SQLite database driver |
| `sqlite-vec` | Vector similarity search extension for SQLite |

Total install size: ~50MB (mostly the ONNX runtime). The embedding model (~25MB) is downloaded on first run and cached locally.

## License

Same as OpenClaw — see [LICENSE](../../LICENSE).
