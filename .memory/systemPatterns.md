# System Patterns

- **Architecture**: Hybrid search (Vector + Keyword) using LanceDB.
- **Modular Plugin Pattern**: Large plugins (like `memory-hybrid`) MUST be split into specialized modules:
  - `database.ts`: Persistence and low-level DB operations.
  - `tools.ts`: All AI-facing tool registrations and implementations.
  - `cli.ts`: Developer CLI commands.
  - `hooks.ts`: OpenClaw lifecycle hook subscribers.
  - `index.ts`: Lightweight bootstrap/dependency injector.
- **TDAID**: Standard 5-stage loop. Test first, implement second.
- **Security Pattern**: NEVER inject untrusted data (user memories, external strings) directly into LLM prompts. Always use `escapeMemoryForPrompt` or equivalent wrapping/sanitization.
- **Concurrency & Atomicity**: Multi-step graph and database operations MUST use the `withLock` pattern for shared state to prevent race conditions.
- **Persistence First**: Any state held in buffers (e.g., `WorkingMemoryBuffer`) must implement JSONL persistence (`save`/`load`) to survive restarts.
- **CLI Contract**: CLI commands must strictly follow `--limit` parameters to prevent output bloat.
- **Knowledge Graph**: Multi-hop retrieval using relation nodes.
- **Memory Paradigm**: Two-Stage Retrieval (Radar Context + On-Demand Fetch).
- **Agent Observability**: Structured JSON Lines (JSONL) tracing written to runtime data folders.
- **Background Orchestration**: Heavy operations (Smart Capture, Graph Extraction) are offloaded to a sequential `MemoryQueue` with inter-task delays.
- **Batch Embeddings**: Always use `embeddings.embedBatch` for bulk operations (Dream Mode, Batch Capture) to satisfy High TPM / Low RPM limiters.
