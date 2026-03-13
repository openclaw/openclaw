# Ideas Log — OpenClaw → X1 Advisor

Running log of ideas and inspiration drawn from the OpenClaw codebase.

---

## 2026-03-13 — Initial Review

### Memory Auto-Flush
OpenClaw has a clever pattern where, before context compaction (when the conversation gets too long), it triggers an agentic turn that asks the model to save any important information to persistent memory. This prevents memory loss in long conversations. **X1 Advisor should implement something similar** — before trimming chat history, prompt the agent to extract and save key facts.

### Session Isolation + Cross-Session Communication
OpenClaw supports isolated sessions per agent but also provides `sessions_list`, `sessions_history`, `sessions_send` tools for cross-session coordination. This maps well to X1's need for **team-shared memory** — each user has their own session, but the agent can access other team members' session history when relevant.

### Skill Plugin System
OpenClaw has 54 skill plugins that extend the agent's capabilities. For X1, this could translate to **domain-specific tools** like:
- `query_evaluations` — search evaluation results
- `query_startups` — look up startup data
- `navigate_to` — open a specific page in the XRM
- `run_evaluation` — trigger a pitchdeck evaluation
- `export_report` — generate a PDF report

### Browser Control via CDP
OpenClaw uses Playwright's Chrome DevTools Protocol for browser automation. While X1 Advisor probably won't control the browser directly (it's embedded in the app), the **concept of giving the agent UI actions** is relevant — the agent should be able to trigger frontend navigation and actions through the app's API.

### Hybrid Search (BM25 + Vector)
For searching evaluation data and startup information, a hybrid approach (keyword + semantic) would give better results than pure vector search. This is especially relevant for searching structured data like company names, evaluation scores, etc.

---
