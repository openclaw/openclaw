# System Patterns (Memory Hybrid)

- **TDAID Methodology:** Always write a red test before changing any logical behaviors. Ensure tests assert failure conditions realistically.
- **Architectural Constraints:**
  - No silent async failures (use structured logging + `MemoryTracer`).
  - Store-before-Delete: Ensure DB entries are created successfully before executing the `.delete()` operations on previous versions.
  - LLM Parsing Resilience: Assume JSON extraction can fail; fallback logic is required.
  - LanceDB Operations: Avoid parallel `Promise.all` on single-row updates (MVCC commit conflicts); use sequential processing or `deleteBatch`.
  - Plugin Lifecycle: `start` and `stop` hooks MUST be async if they interact with DB/file I/O to avoid race conditions with incoming events.
  - Alignment in Map/Filter: When processing LLM outputs for mapping to source data, never use `.filter` to remove invalid rows if the index positions map back to original data. Use `[value, null]` arrays instead.
