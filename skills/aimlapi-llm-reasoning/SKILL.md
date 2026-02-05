---
name: aimlapi-llm-reasoning
description: Run AIMLAPI LLM and reasoning workflows through chat completions with retries, structured outputs, and explicit User-Agent headers. Use when Codex needs scripted prompting/reasoning calls against AIMLAPI models.
---

# AIMLAPI LLM + Reasoning

## Overview

Use `run_chat.py` to call AIMLAPI chat completions with retries, optional API key file fallback, and a `User-Agent` header on every request.

## Quick start

```bash
export AIMLAPI_API_KEY="sk-aimlapi-..."
python3 {baseDir}/scripts/run_chat.py --model aimlapi/openai/gpt-5-nano-2025-08-07 --user "Summarize this in 3 bullets."
```

## Tasks

### Run a basic chat completion

```bash
python3 {baseDir}/scripts/run_chat.py \
  --model aimlapi/openai/gpt-5-nano-2025-08-07 \
  --system "You are a concise assistant." \
  --user "Draft a project kickoff checklist." \
  --user-agent "openclaw-custom/1.0"
```

### Add reasoning parameters

```bash
python3 {baseDir}/scripts/run_chat.py \
  --model aimlapi/openai/gpt-5-nano-2025-08-07 \
  --user "Plan a 5-step rollout for a new chatbot feature." \
  --extra-json '{"reasoning": {"effort": "medium"}, "temperature": 0.3}'
```

### Structured JSON output

```bash
python3 {baseDir}/scripts/run_chat.py \
  --model aimlapi/openai/gpt-5-nano-2025-08-07 \
  --user "Return a JSON array of 3 project risks with mitigation." \
  --extra-json '{"response_format": {"type": "json_object"}}' \
  --output ./out/risks.json
```

## References

- `references/aimlapi-llm.md`: payload and troubleshooting notes.
- `README.md`: changelog-style summary of new instructions.
