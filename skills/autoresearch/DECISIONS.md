# Autoresearch — Architecture Decisions

## 2026-04-15: Phase 1 Mechanism = Option A (OAuth Token Direct)

**Context:** The spec's Phase 1 says "15 Opus + 5 Sonnet experiments via Claude Code Task tool." But OnSessionStart hooks execute as separate shell processes outside the Claude Code main agent's context — they cannot directly invoke the Task tool from outside the agent loop.

**Three options evaluated:**

- **A. OAuth Token Direct** — Hook reads the OAuth token from `~/.claude/.credentials.json` and uses it as the API key for raw Anthropic API calls during Phase 1. Bills against Max subscription quota just like in-session Claude Code usage.
- **B. Slash Command** — Hook triggers a tiny launcher that opens Claude Code with `/autoresearch-morning`, which runs inside the session and can spawn Task subagents properly. Depends on user to be in-session.
- **C. Collapse to Phase 2** — Skip Phase 1 entirely. Use raw API with `ANTHROPIC_API_KEY` for all experiments, bump daily cap from $4 to $6 to cover what Phase 1 would have provided for "free."

**Decision: Option A.**

**Why:**
1. **Preserves the Max-subscription value.** The whole point of Phase 1 was to get 20 experiments/day for free (flat-rate). Options B/C either complicate or abandon that.
2. **No user action required.** Hook fires → loop runs → PDF opens. Matches the original "walk the dog" workflow.
3. **Sidesteps Codex Finding #3.** Direct API calls with a scoped OAuth token don't inherit the user's broader session context (Gmail OAuth, GitHub creds, etc.). No prompt-injection attack surface via Task subagents.
4. **Technically feasible today.** `~/.claude/.credentials.json` exists with `accessToken` field (verified 2026-04-15). The `@mariozechner/pi-ai` client accepts any `apiKey`-shaped string — we pass the OAuth `accessToken` instead of a regular API key, and Anthropic's OAuth endpoints accept it.

**Risks accepted:**
- OAuth token rotation: if Anthropic rotates the token mid-run, Phase 1 fails partially. Phase 2 (raw API key) continues independently — graceful degradation. Loop catches the error and logs it in the report.
- Max subscription quota: 15 Opus + 5 Sonnet/day should fit well within 5-hour rolling window limits. Monitor via Day 6 evaluation report.

**Fallback:** If OAuth token approach hits unforeseen blockers during implementation, fall back to Option C (collapse to Phase 2, raise cap to $6). This is a <1-hour code change.

**Impact on implementation plan:**
- Task 12 (`loop.mjs`) Phase 1 block uses OAuth token from `~/.claude/.credentials.json`, read at runtime.
- No change to Tasks 0-11, 13-15.
