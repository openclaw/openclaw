## QVerisBot 2026.3.8 Release Notes

**Previous version:** 2026.3.3 | **Release date:** March 8, 2026

This release merges the latest OpenClaw upstream (through v2026.3.7 stable) and introduces three major QVerisBot-specific enhancements.

---

### New: Memory Enhancement

QVerisBot now ships with an advanced memory management system built on two bundled hooks:

- **`context-digest`** — Maintains a rolling cross-session digest that survives compaction and session resets, giving the agent persistent awareness of prior conversations without bloating the context window.
- **`session-importance`** — A two-stage importance classifier that evaluates conversation turns and prioritizes high-signal content for long-term retention.
- **Shared infrastructure** — New shared utilities (`transcript-reader`, `llm-memory-helpers`) provide transcript parsing, LLM orchestration with mutex/dedup, and a system prompt anchor (`context-digest-anchor`) that injects digest context at the right position in the prompt. Native memory flush is handled automatically at the end of each agent run.

### New: Natural Language Model Switching

A new `switch_model` tool allows users to change the active LLM model through natural language — no config editing required.

- **Fuzzy matching** — Handles partial names, common aliases, and case-insensitive input (e.g., "use claude sonnet", "switch to gpt-4o").
- **Ambiguity detection** — When multiple models match a query, the agent presents candidates and asks the user to clarify instead of guessing.
- **Silent reset notifications** — When a model override is cleared (e.g., by session reset), a system event notifies the agent so it can inform the user transparently.

### New: Qveris Integration Enhancement

The Qveris tool integration has been significantly upgraded with smarter routing and session awareness:

- **Structured routing decision tree** — `buildQverisSection()` now generates a 6-step decision tree in the system prompt with explicit anti-patterns (local filesystem ops, docs/tutorials, non-English queries), guiding the agent on when to use Qveris vs local tools vs `web_search`.
- **`qveris_get_by_ids` tool** — A new tool that verifies known tool IDs via `POST /tools/get-by-ids` without a full search, reducing unnecessary API calls when the agent already knows which tools to use.
- **Session-scoped tool rolodex** — Successful tool executions are recorded in a per-session rolodex. Search results are annotated with `previously_used` and `session_uses` metadata, and `session_known_tools` is exposed to the agent so it can reuse proven tools efficiently.
- **Improved search boundaries** — `qveris_search` descriptions now include negative boundaries and GOOD/BAD examples to prevent task-goal searches and improve search precision.

### Merged from OpenClaw Upstream (v2026.3.7)

Key upstream changes included in this release:

**Features**

- Context Engine plugin interface with full lifecycle hooks for alternative context management strategies
- ACP persistent channel bindings for Discord and Telegram (survives restarts)
- Telegram per-topic `agentId` overrides for forum groups and DM topics
- Google Gemini 3.1 Flash-Lite first-class support
- Mattermost interactive model picker
- Gateway SecretRef support for `gateway.auth.token`
- Docker multi-stage build with `slim` variant support
- Compaction safeguard tuning and post-context configurability
- iOS App Store Connect release preparation
- Web search provider selection in onboarding wizard

**Fixes**

- 60+ bug fixes across gateway auth, Telegram routing, Discord session keys, Slack typing/dedup, Feishu streaming, cron delivery, sandbox hardening, voice-call config, TUI session isolation, and more
- Security hardening: cross-origin redirect header filtering, fs-bridge path safety, zip extraction writes, cron file permissions
- Dependency security patches for Hono and tar

---
