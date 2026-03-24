# Proposal: Local Provider Toolcalling Standardization

## Overview

OpenClaw's ability to run fully autonomous agentic loops highly depends on stable tool execution (function calling). While premium API models (OpenAI, Anthropic) have stable native tool-calling capabilities, the local model ecosystem (especially smaller or quantized models accessed via Ollama, LMStudio, or llama.cpp) struggles significantly. 

Common community issues include:
1. **Parser Loops:** Parsers confusing internal model reasoning (e.g., `<think>` blocks in DeepSeek or Qwen) with tool commands, causing infinite loops.
2. **Streaming Failures:** Emitting empty or malformed `tool_calls` during streaming (`stream: true`).
3. **Format Fragmentation:** Models natively supporting different ad-hoc formats (OpenAI-compatible, Anthropic XML, custom DSLs).

This proposal introduces a unified **Discovery and Standardization Layer** for local models, providing automatic format detection and a highly robust ReAct fallback for models that lack native tool capabilities.

---

## Architectural Design

The implementation is designed to be non-destructive. It coexists with existing patches (like Ollama's `streamToolCalls`) and only triggers via explicit provider config or automatic discovery fallback.

### 1. `capabilities-discovery.ts` (The Discovery Layer)
A new module responsible for querying the local endpoint (e.g., `/v1/models` for LMStudio or `/api/tags` for Ollama) during agent boot.
- **Goal:** Analyze the model metadata to determine its native tool format.
- **Output Enum:** `toolFormat: 'openai' | 'anthropic-xml' | 'ollama-dsl' | 'none'`.

### 2. `models-config.providers.ts` (Provider Enhancements)
Introduces two new configuration flags for provider definitions:
- `toolFallback`: `"react" | "none" | "auto"` (Default: `auto`). Dictates whether to inject the ReAct fallback prompt.
- `reactProfile`: `"minimal" | "verbose"` (Default: `minimal`). Controls the token density of the injected ReAct system prompt to save context windows on models that don't need heavy instruction.

### 3. `react-fallback-stream.ts` (The Universal Fallback)
A stream interceptor wrapped around the standard text stream. If `toolFormat === 'none'` or `toolFallback === 'react'`, this wrapper activates:
- **Reasoning Sanitizer:** A pre-parser that actively strips out `<think>...</think>` tags *before* tool parsing occurs. This directly addresses the LMStudio recursive reasoning bug.
- **Format Injection:** Injects a ReAct (Thought/Action/Observation) System Prompt.
- **Stream Interception:** Parses `Action: { "tool": "name" ... }` output on the fly and converts it into standard OpenClaw `ToolCall` events.
- **Timeout Recovery:** Implements a strict 15-second trailing timeout to prevent the agent from hanging indefinitely when a local model aborts its stream silently.

---

## Target Support Matrix

This architecture is built to ensure agentic workflow stability across:
- **Runtimes:** `ollama`, `lmstudio`, `llama.cpp`
- **Model Families:** `qwen3` / `qwen3.5`, `mistral`, `llama3.3/3.1`, `deepseek`, `glm-flash`, `gpt-oss`.

## Testing & Stability

To prevent future regressions in the tool-layer fallback, this contribution includes **E2E Streaming Fixtures**. These test suites use real, recorded streaming deltas (mocked network responses) from popular local models to ensure the fallback logic and reasoning sanitizers work deterministically.
