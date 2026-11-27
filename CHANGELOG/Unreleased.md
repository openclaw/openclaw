## Unreleased

### Changes

- Setup: `openclaw setup --baseline` no longer writes the starter workspace files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`) or runs `git init`; the agent's first conversation creates them. Scripts that edit the generated templates right after baseline setup should ship their own files instead; the first conversation keeps existing files.
- Models: OpenAI-protocol routes (including custom base URLs and proxies) now decide `strict` per tool: a tool whose schema is strict-compatible as written is sent strict, instead of every tool going non-strict when one schema could not use it. A route that refuses strict tools with a strict or schema error is retried once without them and remembered; set `compat.supportsStrictMode: false` to skip the first attempt.

### Fixes

- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
