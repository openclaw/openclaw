# Prompt Stack Spec — system prompt vs workspace files (operator-facing)

**Status:** spec, Round 2 (2026-04-17). Guides the next iteration of prompt-mass reduction; no large prompt rewrites land from this doc. The only prompt change shipping with this spec is the GPT-5 family context-file boot reorder (SOUL.md / IDENTITY.md before AGENTS.md) — see [GPT-5 family trigger conditions](#gpt-5-family-trigger-conditions) below.

---

## Why this spec exists

During GPT-5.4 personality testing, Eva (the agent) kept drifting toward a "careful operations daemon with a personality garnish" instead of "a coherent agent with strong judgment and style." The adversarial review identified the root cause:

- Identity (SOUL.md, friendly overlay) is aspirational; it tells the model _who it is_.
- Execution rules (AGENTS.md, Execution Bias, Tool Enforcement, anti-verbosity, tool-first defaults) are concrete; they tell the model _what to do right now_.
- When these compete for attention, **execution wins by default** because concrete beats aspirational at action-selection time.

A second contributor: workspace files routinely duplicate generic system-level guidance (brevity, tool-first, anti-sycophancy), crowding out the unique persona material that only those files can own.

This spec defines the boundary.

---

## Precedence model — one identity, multiple stances

The adversarial review explicitly **rejected** a lane-based personality-vs-agentic split as a trap. Hard-splitting would produce:

- sterile execution mode (no warmth even when the context warrants it)
- performative personality mode (forced warmth even when terse action is needed)
- leakage between both (worst of each)

The correct framing is **one identity, multiple stances**. Same persona, throttled by context:

| Stance                 | When                                                 | Tone                                   | Action posture                 |
| ---------------------- | ---------------------------------------------------- | -------------------------------------- | ------------------------------ |
| Incident / debug       | error triage, broken build, rollback                 | terse, no narration                    | tool-first, no preamble        |
| Build / execution      | implementing an approved plan                        | warm in the framing; terse in the work | act-now between tool calls     |
| Companion / reflective | architectural discussion, post-mortem, design review | full personality range                 | slow down; propose and explore |

The agent reads the stance from context signals (user phrasing, urgency markers, whether a plan is approved, channel type) rather than from a hard mode switch. The system prompt sections compose into this — no per-stance conditionals in core.

---

## Belongs in the system prompt

These are generic across agents and customers. Do NOT repeat them in workspace files:

- **Brevity rules.** The GPT-5 output contract already caps default replies at ~200 words with a long-form exception.
- **Anti-sycophancy.** "PROHIBITED: 'I'd be happy to help', 'Certainly!', stock empathy" lives in the friendly overlay.
- **Tool-first defaults.** Execution Bias + Tool Enforcement drive this for GPT-5; `runBeforeToolCallHook` drives loop detection.
- **Ask-vs-act policy.** The approval / mutation-gate boundary is owned by `src/agents/plan-mode/mutation-gate.ts` and the friendly overlay's "start in the same turn" text.
- **Verification discipline.** Generic rules live in the output contract; test/build discovery is covered by tool availability.
- **Safety / approvals / guardrails.** Hardcoded in `buildAgentSystemPrompt()` lines ~715+.
- **Heartbeat contract.** The dynamic section near the cache boundary owns the runtime contract; HEARTBEAT.md adds project-specific guidance only.
- **Bootstrap / prompt-assembly semantics.** Project context file ordering, section overrides, dynamic-suffix placement.
- **Provider-specific tuning.** The OpenAI GPT-5 overlay injects OUTPUT_CONTRACT, TOOL_CALL_STYLE, EXECUTION_BIAS, TOOL_ENFORCEMENT, and (when `personality: "friendly"`) INTERACTION_STYLE.

If you find yourself writing rules like these in SOUL.md or AGENTS.md, you're duplicating. Move them back into the generic path — or delete if the system prompt already covers them for your target model.

---

## Belongs in workspace files

These are customer- or agent-specific. The system prompt does NOT own these:

- **Persona / voice / tone character.** SOUL.md — "who this agent IS, not generic-polite." Identity phrases, metaphor preferences, signature cadence, relationship language.
- **Customer-specific autonomy rules.** AGENTS.md — "when to delegate," "which operations require approval even in normal mode," project-specific scars ("we were burned by X in 2025-10; always Y").
- **Org / business context.** USER.md — stakeholders, preferred channels, time zones, escalation paths, non-obvious company context.
- **Local workflow rules.** Domain vocabulary, project-specific commands, shell aliases, test incantations peculiar to this repo/workspace.
- **Identity narrative.** IDENTITY.md — biography, continuity threads, what has happened before on this session family.
- **Long-term memory.** MEMORY.md / cortex-backed recall. Facts the agent should know without re-reading past transcripts.
- **Heartbeat priorities.** HEARTBEAT.md — which standing workstreams matter right now. Not "how heartbeats work" (that's system) but "what to work on during heartbeat time" (that's you).

---

## Dangerous duplication / conflict surfaces

Things we've seen repeatedly in workspace files that should be **removed** (system prompt already covers them):

1. **Re-stating "be concise" / "don't preamble."** The output contract handles this for GPT-5; Anthropic/Gemini have their own defaults. Your workspace file saying it a fourth time competes for attention and signals "this is optional."
2. **Re-stating "use tools first."** Execution Bias owns this. If your workspace says "always use tools before answering," you're hard-overlapping.
3. **Anti-sycophancy phrases as a do-not list.** Already in the friendly overlay. Listing them again in SOUL.md tells the model "sycophancy is in scope enough to enumerate."
4. **Heartbeat behavior descriptions.** The dynamic section + the main friendly overlay already describe what heartbeats ARE. Your HEARTBEAT.md should say what to DO — concrete current tasks — not re-explain the mechanic.
5. **Confidentiality / safety platitudes.** System prompt covers these generically. Project-specific ones ("never commit real phone numbers") belong in AGENTS.md as project scars — but only if materially different from the generic rule.
6. **Meta about how the agent should read files.** "Read AGENTS.md before acting" is not needed — files are injected directly into the system prompt already.

Rule of thumb: **if the guidance would apply equally to an agent at a different customer, it belongs in the system prompt, not your workspace file.**

---

## GPT-5 family trigger conditions

The OpenAI prompt overlay applies when BOTH conditions hold:

1. `modelProviderId === "openai"` OR `modelProviderId === "openai-codex"`
2. `modelId.toLowerCase().startsWith("gpt-5")` (matches `gpt-5.4`, `gpt-5-turbo`, `gpt-5o`, etc.)

When both match, these inject:

- `OPENAI_GPT5_OUTPUT_CONTRACT` (output length + punctuation rules) — added to `stablePrefix`.
- `OPENAI_GPT5_TOOL_CALL_STYLE` — added to `stablePrefix`.
- `OPENAI_GPT5_EXECUTION_BIAS` → overrides section `execution_bias`.
- `OPENAI_GPT5_TOOL_ENFORCEMENT` → overrides section `tool_enforcement`.
- `OPENAI_FRIENDLY_PROMPT_OVERLAY` → overrides section `interaction_style` (only when `plugins.entries.openai.config.personality !== "off"`; defaults to `"friendly"`).

### What does NOT get the overlay

- Anthropic Claude models (Opus / Sonnet / Haiku).
- Google Gemini models.
- Non-GPT-5 OpenAI models (`gpt-4.1`, `gpt-4o-mini`, etc.).
- The minimal subagent prompt mode drops a lot of stable-prefix content; mission-critical persona for subagents must live in SUBAGENTS.md, not just SOUL.md.

### GPT-5 boot reorder (Round 2, landing with this spec)

For OpenAI GPT-5 models only, workspace-file load order is adjusted:

| Default order         | GPT-5 override                |
| --------------------- | ----------------------------- |
| AGENTS.md (weight 10) | SOUL.md (10)                  |
| SOUL.md (20)          | IDENTITY.md (20)              |
| IDENTITY.md (30)      | AGENTS.md (30)                |
| USER.md (40)          | USER.md (40) — unchanged      |
| TOOLS.md (50)         | TOOLS.md (50) — unchanged     |
| BOOTSTRAP.md (60)     | BOOTSTRAP.md (60) — unchanged |
| MEMORY.md (70)        | MEMORY.md (70) — unchanged    |

**Why:** the friendly overlay itself says "If SOUL.md is present, it is your PRIMARY identity document." When AGENTS.md (full of process/operations rules) is read FIRST, it primes the model into operations mode before persona has a chance to establish tone. Loading persona first gives it the priority the overlay promises.

**Why only GPT-5:** that's where the personality drift was observed. Anthropic and Gemini have different priors; the change might not help (and could hurt) for them. Scoping narrowly keeps the change low-risk.

---

## Targeted compression candidates for the next iteration

Per the adversarial review recommendation, target a ~30% system-prompt mass reduction. These are candidates with risk grades; do NOT ship all at once without measurement.

### Low risk (~12-15% reduction combined)

- **Self-Update + Model Aliases sections** (~200 tokens). Conditional on `hasGateway`; prune rarely-used model aliases; consolidate self-update copy.
- **Sandbox/Workspace housekeeping** (~300 tokens). Move the long sandbox/workspace description to the dynamic suffix or load on-demand.
- **Output Directives variant enumerations** (~250 tokens). One variant per channel instead of listing all.

### Medium risk (~10% additional)

- **Tooling section compression** (~400 tokens). Compress tool summaries; defer non-essential tooling guidance to tool-specific descriptions.
- **Defer Docs section to dynamic suffix** (~100 tokens).

### High risk — DO NOT compress this iteration

- **Execution Bias.** This is the anti-drift lever. Touching it risks regressing agentic behavior.
- **Tool Enforcement.** Same.
- **Interaction Style (friendly overlay).** The voice calibration is load-bearing; removing it loses GPT-5 warmth entirely.
- **Identity Enforcement section in the friendly overlay.** The SOUL-first-priority language is what makes persona beat sycophancy.

### Measurement plan before compressing

Before any compression PR:

1. Baseline: record system-prompt token count at HEAD for 3 representative sessions (OpenAI GPT-5.4, Anthropic Claude Opus, Google Gemini).
2. Run each of 5 QA scenarios (`gpt54-act-dont-ask`, `gpt54-cancelled-status`, `gpt54-injection-scan`, `gpt54-mandatory-tool-use`, `gpt54-plan-mode-default-off`) 3x and record agentic-compliance pass rate.
3. Ship compression, repeat step 2. Any regression ≥1 pass point on any scenario → revert.

---

## Plan length / depth (item from user status feedback)

**No hard cap** on `update_plan` step count or text length. The renderer + sidebar + approval-card layout pressure the agent toward terse plans. If you want longer plans:

- Ask the agent: _"give me a 12-step plan with sub-steps and code-path references"_.
- Set `plan-mode auto-continue` budget higher so the agent doesn't abbreviate to fit expected execution time.
- Add a workspace note in AGENTS.md: _"When producing plans for this repo, include file:line references and 8-15 steps minimum."_

We deliberately did **not** add a min-step-count config knob. Plan depth is a quality dimension, not a volume dimension; forcing length would hurt signal-to-noise. If the agent is under-planning on a specific session family, an AGENTS.md note is the right surface.

---

## What we're NOT doing in this iteration

Deferred to a follow-up PR with dedicated measurement:

- Rewriting any prompt section beyond the boot reorder.
- Adding a precedence table to the top of the system prompt (considered; deferred until we can A/B it).
- Removing duplications from existing customer-facing SOUL.md / AGENTS.md files (that's a per-customer migration — out of scope for a core change).

See also:

- `extensions/openai/prompt-overlay.ts` — overlay source of truth.
- `src/agents/system-prompt.ts` — `DEFAULT_CONTEXT_FILE_ORDER` + `GPT5_CONTEXT_FILE_ORDER` + `sortContextFilesForPrompt`.
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts` — runtime detectors that catch action-selection drift (ack-only, yield-after-approval).
