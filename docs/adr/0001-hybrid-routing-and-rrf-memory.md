# ADR 001: Hybrid Inference Routing & RRF Memory Normalization

**Date:** 2026-05-06
**Status:** Accepted

## Context

1. **Memory Retrieval Degradation:** The introduction of Reciprocal Rank Fusion (RRF) for memory search yielded raw scores (e.g., ~0.016) that consistently failed to clear the OpenClaw gateway's default `minScore` threshold of `0.35`, resulting in empty retrievals.
2. **Inference Instability:** Relying on single, free-tier cloud models caused frequent gateway timeouts. Furthermore, the OpenClaw schema silently deprecated the `models.providers.ollama.wol` parameter, breaking automated Wake-on-LAN for the local inference node (CachyOmen).

## Decision

1. **RRF Scaling:** Implement and enforce mathematical normalization (`rrfNormalizeScale = (k+1)/weightSum`) to stretch RRF scores into a standard distribution, allowing valid semantic hits to safely clear the `0.35` threshold.
2. **Hybrid Routing Chain:** Bypass the OpenRouter auto-router and implement a rigid, 6-tier fallback chain optimized for structured agentic reasoning:
   - Primary: `openrouter/<your-named-route>` (Nemotron 120B)
   - Cloud Fallback 1: `openrouter/openai/gpt-oss-120b:free`
   - Cloud Fallback 2: `openrouter/minimax/minimax-m2.5:free`
   - Cloud Fallback 3: `openrouter/qwen/qwen3-coder-480b-a35b:free`
   - Edge Fallback 1: `ollama/llama3.1:8b`
   - Edge Fallback 2: `ollama/gemma3:4b`
3. **Hardware Orchestration:** Acknowledge the loss of native WoL support in the v2026.5 schema. Defer the creation of a decoupled, host-level WoL watchdog to a future sprint.

## Consequences

- **Positive:** The gateway is now highly resilient to cloud outages, maintaining autonomous agent loops without manual intervention. Memory retrieval is accurate and functional.
- **Negative:** Until the standalone WoL watchdog is developed, CachyOmen must be awakened manually via the host socket (`/run/user/1000/openclaw-wol.sock`) if it enters a sleep state.
