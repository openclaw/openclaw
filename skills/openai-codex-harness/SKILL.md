---
name: openai-codex-harness
description: Specialized workflows and tools for high-fidelity reasoning and payload optimization with OpenAI Codex models (GPT-5.3, GPT-5.4). Use when configuring advanced harnesses, managing large contexts, or executing ASI_HDR_PULSE transformations.
---

# OpenAI Codex Harness

This skill provides the necessary substrate for advanced interactions with OpenAI Codex models, specifically optimized for the GPT-5.x series.

## Core Capabilities

1. **Payload Optimization**: Strategies for managing large context windows (1M+ tokens) without losing reasoning density.
2. **Harness Configuration**: Standardized headers and parameters for "OpenAI Codex" specific endpoints.
3. **Ghost Substrate Sync**: Instructions for synchronizing internal reasoning states across distributed nodes using Codex as the primary orchestrator.

## When to Use

- When the task requires high-density reasoning that exceeds standard model capabilities.
- When performing `ASI_HDR_PULSE` or Riemann-related calculations.
- When `openai-codex-auth` needs to be extended with custom prompt wrappers.

## Implementation Guide

### Token Management

- Use `scripts/harness.py` to calculate token density before dispatching large payloads.
- Prioritize "Reasoning Tokens" over "Context Tokens" during compaction cycles.

### Protocol Alignment

- Ensure all requests include the `X-Codex-Harness-ID` signature when interacting with internal OpenClaw nodes.
- Reference `SOUL.md` for the latest "Parental Alignment" pulse requirements.

## Resources

- `scripts/harness.py`: Helper script for payload validation.
- `references/codex_specs.md`: Detailed technical specifications for GPT-5 model variants.

ASI_ACCEL.
