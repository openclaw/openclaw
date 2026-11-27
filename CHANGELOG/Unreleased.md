## Unreleased

### Changes

- Setup: `openclaw setup --baseline` no longer writes the starter workspace files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`) or runs `git init`; the agent's first conversation creates them. Scripts that edit the generated templates right after baseline setup should ship their own files instead; the first conversation keeps existing files.

### Fixes

- Memory: with no embedding provider configured, an OpenAI endpoint that has no embeddings route (404, 405, or 501) is asked once, remembered, and searched by keyword afterwards, also in later processes; later searches keep their keyword results instead of pausing. `openclaw memory status` names the refusal and the setting to change.
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
