---
name: docs-translator
description: This skill provides an industrial-grade, highly resilient automated workflow for translating technical Markdown documentation. It features Self-healing (Batch-to-Single paragraph fallback) and Model-aware Batching to handle massive docsets at extreme low cost while ensuring 100% code block integrity.
---

# Docs Translator (Industrial Grade)

This skill instructs Claude on how to set up and manage an automated, unattended translation pipeline.

## The Core Philosophy (Unstoppable Architecture)

### 1. Self-Healing Batching

Large batch processing (e.g., 10-15 paragraphs) speeds up translation and saves API requests (RPD). If a batch fails validation, the system automatically degrades to Single Paragraph Mode to isolate and fix the error.

### 2. Model-Aware Optimization

- **Mini Models (gpt-4o-mini, gpt-5-mini)**: Use larger batches (15+) to save quota.
- **Flagship Models (gpt-4o, gpt-5)**: Use smaller batches (5) for maximum precision.

### 3. Mechanical Tag Masking [[P_B_N]]

Placeholders now include paragraph and block indices to prevent cross-paragraph tag swapping in large batches.

### 4. Pre-restoration Cleaning

Strip all hallucinated backticks before unmasking to neutralize LLM formatting tendencies.

## Advanced Troubleshooting

### 1. Parameter Incompatibility

- Some new models (like gpt-5-mini) require 'max_completion_tokens' instead of 'max_tokens' and may restrict 'temperature' values. Always check model-specific parameter schemas.

### 2. OpenAI 400 Bad Request

- Caused by payload corruption. Use '.normalize("NFC")' and sanitize control characters before the API call.

## Modular Components

- **engine-core.ts**: The brain (Masking, Cleaning, Validation, Backoff).
- **file-io.ts**: The storage & git manager.
- **main-pipeline.ts**: The orchestrator with Self-healing logic.
