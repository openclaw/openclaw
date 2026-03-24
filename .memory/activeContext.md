# Active Context

- Goal: Resolve 429 Rate Limits and Latency via Background Memory Queue.
- Status: Completed 🟢
- Strategy: **Orchestrated Async Queue**
  - Instant response to user by offloading memory tasks to a worker.
  - Strict sequential processing with 1.5s inter-task delays to stay under 15 RPM.

## Completed Checklist

- [x] PLAN: Architecture for `MemoryQueue` in `queue.ts`.
- [x] RED: `queue.test.ts` for sequential task execution and 1s delay.
- [x] GREEN: Implement `MemoryQueue` with concurrency: 1 and configurable delay.
- [x] REFACTOR: Move `smartCapture` and `extractGraph` into `MemoryQueue` in `index.ts`.
- [x] VALIDATE: Verify "Response First" UX and sequential background processing.
