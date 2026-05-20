---
summary: "Semantic codebase search via claude-context MCP, Milvus, and Ollama"
read_when:
  - You want to set up semantic code search for Claude Code on this repo
  - Indexing failed and you need to restart it
  - You want to understand how the Milvus + Ollama stack fits together
title: "Codebase Search (claude-context)"
---

# Codebase search (claude-context)

Claude Code can semantically search the OpenClaw codebase using the `claude-context` MCP server. It stores vector embeddings in **Milvus** and generates them with **Ollama** (`nomic-embed-text`). All three run locally — no data leaves the machine.

## Stack

| Component            | Role                                   | Address                  |
| -------------------- | -------------------------------------- | ------------------------ |
| `claude-context-mcp` | MCP server (Claude Code child process) | stdio                    |
| Milvus               | Vector database                        | `127.0.0.1:19530`        |
| Ollama               | Embedding model (`nomic-embed-text`)   | `http://127.0.0.1:11434` |
| etcd + MinIO         | Milvus internal dependencies           | internal                 |

Milvus, Ollama, etcd, and MinIO run as Docker containers defined in `docker-compose.yml`.

## Setup

### 1. Start the Docker stack

```bash
cd /path/to/godwind-team-docker/openclaw
docker compose up -d etcd minio milvus-standalone ollama
```

Wait for Milvus to pass its health check (~90 seconds on first start):

```bash
docker compose ps
```

### 2. Pull the embedding model

```bash
docker exec ollama ollama pull nomic-embed-text
```

This only needs to run once; the model is stored in the `ollama_data` Docker volume.

### 3. Install the MCP binary

```bash
npm install -g claude-context-mcp
```

### 4. Configure Claude Code

Add the `claude-context` MCP server to `~/.claude.json`:

```json
{
  "mcpServers": {
    "claude-context": {
      "command": "claude-context-mcp",
      "args": [],
      "env": {
        "MILVUS_ADDRESS": "127.0.0.1:19530",
        "EMBEDDING_PROVIDER": "Ollama",
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "OLLAMA_MODEL": "nomic-embed-text"
      }
    }
  }
}
```

Restart Claude Code after editing `~/.claude.json`.

## Indexing the codebase

Ask Claude Code to index the repo:

> "Index the codebase at `/path/to/openclaw`"

Or trigger it directly via the `index_codebase` MCP tool. Indexing runs in the background. You can search while indexing is in progress, but results will be incomplete until it finishes.

Indexing speed depends entirely on CPU. On a typical VPS (no GPU, 4–8 cores) expect **~20 hours** for a full index. Ollama runs the `nomic-embed-text` embedding model on CPU only — there is no GPU acceleration unless you configure a CUDA-capable Ollama install separately.

The OpenClaw codebase (~8,000 files, ~132,000 chunks) took approximately 21 hours on a standard VPS.

### Check indexing status

> "Check the indexing status for `/path/to/openclaw`"

This uses `get_indexing_status` and shows percentage progress.

### Re-index after failure

If indexing was interrupted (see [Gotchas](#gotchas) below), the status will show `indexfailed`. To restart:

> "Re-index the codebase at `/path/to/openclaw`"

Claude Code will use `force: true` to clear the failed state and start fresh. There is no checkpoint resume — it starts from 0%.

## Gotchas

### Exiting Claude Code stops indexing

The `claude-context-mcp` server is a **child process of Claude Code**. If Claude Code exits, the MCP server is killed and indexing stops immediately. On the next Claude Code start, the server detects the interruption and marks the state as `indexfailed`.

**Safe to do while indexing:**

- Let SSH disconnect (your terminal window closes or PC sleeps)
- Detach from tmux (`Ctrl+B, D`)

**Stops indexing:**

- Typing `exit` inside Claude Code
- Closing Claude Code from a menu or via signal

### Use tmux for long indexing runs

Run Claude Code inside a tmux session so SSH disconnects don't matter. If your connection drops, tmux auto-detaches and Claude Code keeps running. Closing your terminal without explicitly exiting Claude Code is safe.

```bash
tmux new -s claude   # start session
# ... start Claude Code inside tmux
# close terminal or let PC sleep — indexing continues on the VPS
tmux attach -t claude  # reattach later
```

### Milvus startup time

Milvus takes ~90 seconds to become healthy on a cold start. If Claude Code starts before Milvus is ready, the MCP server will fail to connect. Restart Claude Code after the stack is fully up.

## Snapshot state

The MCP server persists indexing state at `~/.context/mcp-codebase-snapshot.json`. This tracks which files have been indexed and the current progress. Do not delete this file while indexing is in progress.

## Future use

The Milvus + Ollama stack is also available to OpenClaw agents running inside Docker (agents on the same Docker network can reach Milvus at `milvus-standalone:19530`). This is groundwork for a future OpenClaw semantic-search context engine.
