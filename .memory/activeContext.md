# Active Context

- Goal: Optimize `memory-hybrid` API usage for High TPM / Low RPM Gemini Free tier.
- Tasks:
  - [ ] Implement `extractGraphFromBatch` in `graph.ts` <!-- id: g1 -->
  - [ ] Implement Batch Fact Processing in `index.ts` <!-- id: i1 -->
  - [ ] Expand Radar limits (Deep: 50, Star-Map: 100) <!-- id: i2 -->
  - [ ] Add trigger filtering to `agent_end` <!-- id: i3 -->
  - [ ] Fix `flushRecallCounts` schema errors <!-- id: i4 -->
- Strategy: **Packet Batching**
  - Consolidate multiple sub-requests into fewer, larger LLM calls.
  - Skip non-user triggers to save quota.
