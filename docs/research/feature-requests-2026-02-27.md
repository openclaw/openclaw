# Top Feature Requests (2026-02-27 Implementation)

_Researched and implemented: 2026-02-27. Sources: OpenClaw GitHub issues, community feedback, and comparable AI assistant/CLI products.  
**Update:** All requests below were implemented in 2026-02-27 (see [Implemented 2026-02-27](#implemented-2026-02-27) and CHANGELOG)._

---

## What’s Already Implemented (Reference)

- **Channels:** WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Google Chat, WebChat, BlueBubbles, MSteams, Matrix, Zalo; extensions: DingTalk, Rocket.Chat.
- **Agent & tools:** Multi-agent routing, Pi bridge, xAI native tools (#6872), plugin lifecycle hooks (#12082), exec compound commands in allowlist (#19046).
- **Memory:** Workspace Markdown (`MEMORY.md`, daily logs), `memory_search` / `memory_get`, pre-compaction memory flush.
- **Security & infra:** Modular guardrails, native MCP client (#21530), Brave LLM Context API, multi-user RBAC (#8081), outbound rate limiting.
- **UX:** Suppress intermediate assistant text between tool calls (#15473), image upload in webchat (handled).

---

## Implemented 2026-02-27

The following feature requests from this research were implemented in a single pass (config, gateway, agents, cron, docs). Config reference: [Configuration Reference](/gateway/configuration-reference). CHANGELOG: “Feature requests 2026-02-27” under 2026.2.27 (Unreleased).

| Issue      | Title                                         | What shipped                                                                                                                                                                               |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **#21538** | Inject-once for workspace bootstrap           | `agents.defaults.bootstrap.injectMode`: `every-turn` \| `once` \| `minimal`; session `bootstrapInjected`; bootstrap resolved once or minimal after first inject.                           |
| **#14812** | Per-tool enable/disable                       | `tools.entries.<name>.enabled`; disabled tools omitted from system prompt.                                                                                                                 |
| **#11479** | Per-agent thinking level                      | `agents.list[].thinkingDefault`; resolution order: session → per-agent → defaults.                                                                                                         |
| **#23281** | User-configurable vision model for image tool | Image tool uses `agents.defaults.imageModel` only; no hardcoded model when config set.                                                                                                     |
| **#23906** | Per-spawn tool profile override               | `sessions_spawn` accepts `tools`: `none` \| `inherit` \| string[]; runner applies filter for child runs.                                                                                   |
| **#13024** | Cron job chaining                             | `triggerOnCompletionOf` (job id) on cron jobs; chained jobs marked due when referenced job completes; cycle validation.                                                                    |
| **#19072** | First-class tool execution approvals          | Request: `riskLevel`, `workflow`; record state: pending/paused/resumed; `exec.approval.pause`, `resume`, `interrupt`; Discord risk in metadata + Interrupt button; decision `interrupted`. |
| **#17078** | Index-rank-compact as core                    | `agents.defaults.context.mode`: `raw` \| `index-rank-compact`; `resolveContextForRun` + stub backend (delegates to raw); integration in attempt/compact/cli-runner.                        |

**Follow-ups (not yet done):** #17078 full backend (index + rank + compact to token budget); optional pause/resume UX in more channels.

---

## Top Feature Requests (Original List — Now Implemented)

_These were the “open” requests as of 2026-02-27; all are now implemented (see above)._

### High impact / frequently cited

| Issue      | Title / idea                         | Why it matters                                                                                                                                        |
| ---------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#21538** | Inject-once for workspace bootstrap  | Inject AGENTS.md, TOOLS.md, etc. once per session instead of every turn. ~90% token reduction on bootstrap in long chats.                             |
| **#17078** | Index-rank-compact as core           | Replace unranked raw injection with indexed/ranked/compacted content (workspace, tool output, memory). Large token and cost savings (~$200/mo cited). |
| **#14812** | Per-tool enable/disable              | `tools.entries.<name>.enabled` to omit unused tool schemas from system prompt. Saves ~2–3k tokens per message when disabling 5–6 tools.               |
| **#11479** | Per-agent thinking level             | Set thinking (off/low/high) per agent in `agents.list[]` instead of one global default. Helps utility vs reasoning agent mix.                         |
| **#19072** | First-class tool execution approvals | Pause / interrupt / resume tool runs with structured approval workflows, risk levels, consistent UX across channels.                                  |

### Workflow & automation

| Issue      | Title / idea                                  | Why it matters                                                                                                                         |
| ---------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **#13024** | Cron job chaining                             | Trigger a job when another completes. Removes polling gaps in multi-agent pipelines (e.g. dev → QA → supervisor).                      |
| **#23906** | Per-spawn tool profile override               | Let `sessions_spawn` pass a tool subset to sub-agents (e.g. “none” or text-only) so small local models don’t fail on full tool schema. |
| **#23281** | User-configurable vision model for image tool | Respect `agents.defaults.imageModel` for the image tool instead of a hardcoded model; supports local/Ollama and cost control.          |

### Other noted requests

- **#13529** (closed as duplicate of #15073): Model-conditional workspace file injection.

---

## Cross-product / industry themes

From Copilot CLI, Codex, and “personal AI assistant” discussions (2024–2025):

- **Persistent memory & session continuity** — Remember across sessions, learn patterns, project-scoped context. OpenClaw already has workspace memory and session state; “learning from patterns” and cross-session profiling are the gap.
- **Smarter approvals** — Less repetitive approval clicks; policy-driven or risk-based approval workflows. Addressed in OpenClaw by #19072 (risk level, pause/resume/interrupt).
- **Session naming, resumption, branching** — Multi-day work without losing context; branch sessions.
- **Plan mode / explainability** — Clear “what will happen” before execution.
- **Context and cost** — Smart context handling, summarization, and smaller effective context. Addressed by #21538 (inject-once), #14812 (per-tool disable), #17078 (context.mode + stub).
- **MCP / integrations** — Project-scoped MCP config and tool lifecycle (OpenClaw has MCP via mcporter and native client).

---

## Links

- [OpenClaw GitHub Issues](https://github.com/openclaw/openclaw/issues)
- [VISION.md](/VISION.md) — current priorities (security, stability, channels, performance).
- [Configuration Reference](/gateway/configuration-reference) — `bootstrap.injectMode`, `context.mode`, `tools.entries`, `agents.list[].thinkingDefault`, cron `triggerOnCompletionOf`, exec approval options.
- [Forks & enhancements (2026-02-26)](/docs/archive/by-date/2026-02-27/completed/forks-and-enhancements-2026-02-26.md) — recently implemented Tier 1/2 items.
