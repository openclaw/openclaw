---
title: "knowledge/models.md Template"
summary: "Model catalog for task-based subagent selection"
read_when:
  - Using subagents with dynamic model selection per task
---

# Available Models

Use this catalog when spawning subagents. Choose the model that best fits the task type.

## Claude Haiku 4.5 — anthropic/claude-haiku-4.5

- Strengths: Structured parsing, classification, simple extraction, scoring, fast turnaround
- Cost: $
- Best when: Task is structured/mechanical, output format is predictable

## Claude Sonnet 4.5 — anthropic/claude-sonnet-4.5

- Strengths: Creative writing, brand voice, nuanced analysis, multi-step reasoning
- Cost: $$$
- Best when: Quality of writing matters, complex analysis, maintaining voice consistency

## Claude Opus 4.6 — anthropic/claude-opus-4.6

- Strengths: Deep multi-step reasoning, complex strategy, difficult judgment calls
- Cost: $$$$
- Best when: Stakes are high, problem requires deep thinking, other models produce poor results

## Gemini 2.5 Flash — google/gemini-2.5-flash

- Strengths: Near-free classification, triage, simple yes/no decisions, fast
- Cost: $ (near-free)
- Best when: High-volume simple tasks, binary classification, quick triage

## GPT-4o — openai/gpt-4o

- Strengths: Strict JSON schema adherence, structured output, broad general knowledge
- Cost: $$$
- Best when: Output must conform to a rigid schema, cross-referencing broad knowledge
