## Task: Make model fallback / cooldown probing faster, less spammy, and more natural

**Goal:** Improve OpenClaw's model fallback behavior so when a primary provider is cooldowned/rate-limited and a healthy cross-provider fallback exists, the request falls through quickly with less warning spam and less repeated in-band probing.
**Context:**

- Relevant files:
  - src/agents/model-fallback.ts
  - src/agents/pi-embedded-runner/run.ts
  - src/agents/model-fallback-observation.ts
  - src/agents/pi-embedded-runner/run/failover-observation.ts
  - tests around model fallback / cooldown probing / embedded runner auth-profile rotation
- Recent observed behavior from logs:
  - Anthropic 429s trigger fallback to openai-codex/gpt-5.4 correctly
  - but there is repeated `probe_cooldown_candidate`, repeated foreground probing of cooldowned Anthropic profiles, repeated warnings, and extra latency before cross-provider fallback wins
    **Constraints:**
- Keep fallback correctness intact
- Prefer fast user-facing fallback over in-band recovery probes when cross-provider fallback exists
- Do not regress same-provider transient recovery behavior unless clearly justified
- Minimize log spam: downgrade or consolidate noisy non-terminal warnings where appropriate
- Make changes surgically; no unrelated cleanup
  **Desired direction:**

1. Foreground path should prefer immediate cross-provider fallback when provider is cooldowned/rate-limited and another provider is available
2. Cooldown probe behavior should be stricter / cheaper / less repetitive
3. Avoid logging intermediate failover states as scary warnings when they are expected and non-terminal
4. Add/adjust tests to lock behavior down
   **Done when:**

- Code implements a meaningfully faster / less spammy fallback path
- Tests covering this behavior pass
- Project builds successfully
- Include a concise summary of what changed, why, and any follow-up PR notes
  **Verify:**
- Run targeted tests for model-fallback and embedded runner failover/cooldown behavior
- Run a build/test command sufficient to confirm the touched code compiles
  **Read first:** AGENTS.md
