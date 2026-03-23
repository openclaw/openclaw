# System Patterns

- Architecture: Hybrid search (Vector + Keyword) using LanceDB.
- Knowledge Graph: Multi-hop retrieval using relation nodes.
- Memory Paradigm: Two-Stage Retrieval (Radar Context + On-Demand Fetch).
- Agent Observability: Structured JSON Lines (JSONL) tracing written to runtime data folders, combined with decoupled terminal tail tools.
- TDAID Cycle: Plan -> Red -> Green -> Refactor -> Validate & Document.
- Dynamic Depth Retrieval: Automatically increases memory search limit (e.g. 3 -> 10) and graph hop count when sensitive or complex keywords (trauma, life, history) are detected in the prompt.
