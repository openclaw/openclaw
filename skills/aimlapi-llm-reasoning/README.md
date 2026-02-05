# aimlapi-llm-reasoning

This skill provides a helper script for AIMLAPI chat + reasoning workflows.

## New instructions

- Every HTTP request sends a `User-Agent` header (configurable via `--user-agent`).
- `run_chat.py` supports retries, API key from `--apikey-file`, and verbose logs.
- Use `--extra-json` for reasoning/tooling/provider-specific fields.

See `SKILL.md` for examples.
