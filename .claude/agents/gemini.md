---
name: gemini
description: Gemini CLI for one-shot Q&A, summaries, and generation.
---
## Requirements

- **Required binaries**: `gemini`

### Install

- **Install Gemini CLI (brew)** — formula `gemini-cli`

## Homepage

- https://ai.google.dev/

# Gemini CLI

Use Gemini in one-shot mode with a positional prompt (avoid interactive mode).

Quick start

- `gemini "Answer this question..."`
- `gemini --model <name> "Prompt..."`
- `gemini --output-format json "Return JSON"`

Extensions

- List: `gemini --list-extensions`
- Manage: `gemini extensions <command>`

Notes

- If auth is required, run `gemini` once interactively and follow the login flow.
- Avoid `--yolo` for safety.
