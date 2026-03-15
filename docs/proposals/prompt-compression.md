# Prompt Compression (Proposal Skeleton)

## Goal
Add optional prompt compression before model calls to reduce token costs while preserving quality.

## Scope (Phase 1)
- Feature flag (default OFF)
- Compression helper integration point in session prompt path
- Safe fallback: if compression fails, use original prompt
- Basic telemetry counters (attempted/success/fallback)

## Non-Goals
- Aggressive semantic rewriting
- Provider-specific behavior changes

## API Sketch
- `compression.enabled: boolean` (default: false)
- `compression.ratio: number` (default: 0.2)

## Safety
- Never throw from compression path
- Always return original prompt on errors

## Test Plan
- Unit: compress helper success/fallback
- Integration: prompt path with feature OFF/ON
- Regression: no behavior change when OFF
