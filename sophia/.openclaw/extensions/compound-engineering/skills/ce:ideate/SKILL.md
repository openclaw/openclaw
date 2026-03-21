---
name: ce:ideate
description: "Generate and critically evaluate grounded improvement ideas for the current project. Use when asking what to improve, requesting idea generation, exploring surprising improvements, or wanting the AI to proactively suggest strong project directions before brainstorming one in depth. Triggers on phrases like 'what should I improve', 'give me ideas', 'ideate on this project', 'surprise me with improvements', 'what would you change', or any request for AI-generated project improvement suggestions rather than refining the user's own idea."
argument-hint: "[optional: feature, focus area, or constraint]"
---

# Generate Improvement Ideas

**Note: The current year is 2026.** Use this when dating ideation documents and checking recent ideation artifacts.

`ce:ideate` precedes `ce:brainstorm`.

- `ce:ideate` answers: "What are the strongest ideas worth exploring?"
- `ce:brainstorm` answers: "What exactly should one chosen idea mean?"
- `ce:plan` answers: "How should it be built?"

This workflow produces a ranked ideation artifact in `docs/ideation/`. It does **not** produce requirements, plans, or code.

## Interaction Method

Use the platform's blocking question tool when available (`AskUserQuestion` in Claude Code, `request_user_input` in Codex, `ask_user` in Gemini). Otherwise, present numbered options in chat and wait for the user's reply before proceeding.

Ask one question at a time. Prefer concise single-select choices when natural options exist.

## Focus Hint

<focus_hint> #$ARGUMENTS </focus_hint>

Interpret any provided argument as optional context. It may be:

- a concept such as `DX improvements`
- a path such as `plugins/compound-engineering/skills/`
- a constraint such as `low-complexity quick wins`
- a volume hint such as `top 3`, `100 ideas`, or `raise the bar`

If no argument is provided, proceed with open-ended ideation.

## Core Principles

1. **Ground before ideating** - Scan the actual codebase first. Do not generate abstract product advice detached from the repository.
2. **Diverge before judging** - Generate the full idea set before evaluating any individual idea.
3. **Use adversarial filtering** - The quality mechanism is explicit rejection with reasons, not optimistic ranking.
4. **Preserve the original prompt mechanism** - Generate many ideas, critique the whole list, then explain only the survivors in detail. Do not let extra process obscure this pattern.
5. **Use agent diversity to improve the candidate pool** - Parallel sub-agents are a support mechanism for richer idea generation and critique, not the core workflow itself.
6. **Preserve the artifact early** - Write the ideation document before presenting results so work survives interruptions.
7. **Route action into brainstorming** - Ideation identifies promising directions; `ce:brainstorm` defines the selected one precisely enough for planning.

## Execution Flow

### Phase 0: Resume and Scope

#### 0.1 Check for Recent Ideation Work

Look in `docs/ideation/` for ideation documents created within the last 30 days.

Treat a prior ideation doc as relevant when:
- the topic matches the requested focus
- the path or subsystem overlaps the requested focus
- the request is open-ended and there is an obvious recent open ideation doc
- the issue-grounded status matches: do not offer to resume a non-issue ideation when the current argument indicates issue-tracker intent, or vice versa — treat these as distinct topics

If a relevant doc exists, ask whether to:
1. continue from it
2. start fresh

If continuing:
- read the document
- summarize what has already been explored
- preserve previous idea statuses and session log entries
- update the existing file instead of creating a duplicate

#### 0.2 Interpret Focus and Volume

Infer three things from the argument:

- **Focus context** - concept, path, constraint, or open-ended
- **Volume override** - any hint that changes candidate or survivor counts
- **Issue-tracker intent** - whether the user wants issue/bug data as an input source

Issue-tracker intent triggers when the argument's primary intent is about analyzing issue patterns: `bugs`, `github issues`, `open issues`, `issue patterns`, `what users are reporting`, `bug reports`, `issue themes`.

Do NOT trigger on arguments that merely mention bugs as a focus: `bug in auth`, `fix the login issue`, `the signup bug` — these are focus hints, not requests to analyze the issue tracker.

When combined (e.g., `top 3 bugs in authentication`): detect issue-tracker intent first, volume override second, remainder is the focus hint. The focus narrows which issues matter; the volume override controls survivor count.

Default volume:
- each ideation sub-agent generates about 7-8 ideas (yielding 30-40 raw ideas across agents, ~20-30 after dedupe)
- keep the top 5-7 survivors

Honor clear overrides such as:
- `top 3`
- `100 ideas`
- `go deep`
- `raise the bar`

Use reasonable interpretation rather than formal parsing.

### Phase 1: Codebase Scan

Before generating ideas, gather codebase context.

Run agents in parallel in the **foreground** (do not use background dispatch — the results are needed before proceeding):

1. **Quick context scan** — dispatch a general-purpose sub-agent with this prompt:

   > Read the project's AGENTS.md (or CLAUDE.md only as compatibility fallback, then README.md if neither exists), then discover the top-level directory layout using the native file-search/glob tool (e.g., `Glob` with pattern `*` or `*/*` in Claude Code). Return a concise summary (under 30 lines) covering:
   > - project shape (language, framework, top-level directory layout)
   > - notable patterns or conventions
   > - obvious pain points or gaps
   > - likely leverage points for improvement
   >
   > Keep the scan shallow — read only top-level documentation and directory structure. Do not analyze GitHub issues, templates, or contribution guidelines. Do not do deep code search.
   >
   > Focus hint: {focus_hint}

2. **Learnings search** — dispatch `compound-engineering:research:learnings-researcher` with a brief summary of the ideation focus.

3. **Issue intelligence** (conditional) — if issue-tracker intent was detected in Phase 0.2, dispatch `compound-engineering:research:issue-intelligence-analyst` with the focus hint. If a focus hint is present, pass it so the agent can weight its clustering toward that area. Run this in parallel with agents 1 and 2.

   If the agent returns an error (gh not installed, no remote, auth failure), log a warning to the user ("Issue analysis unavailable: {reason}. Proceeding with standard ideation.") and continue with the existing two-agent grounding.

   If the agent reports fewer than 5 total issues, note "Insufficient issue signal for theme analysis" and proceed with default ideation frames in Phase 2.

Consolidate all results into a short grounding summary. When issue intelligence is present, keep it as a distinct section so ideation sub-agents can distinguish between code-observed and user-reported signals:

- **Codebase context** — project shape, notable patterns, obvious pain points, likely leverage points
- **Past learnings** — relevant institutional knowledge from docs/solutions/
- **Issue intelligence** (when present) — theme summaries from the issue intelligence agent, preserving theme titles, descriptions, issue counts, and trend directions

Do **not** do external research in v1.

### Phase 2: Divergent Ideation

Follow this mechanism exactly:

1. Generate the full candidate list before critiquing any idea.
2. Each sub-agent targets about 7-8 ideas by default. With 4-6 agents this yields 30-40 raw ideas, which merge and dedupe to roughly 20-30 unique candidates. Adjust the per-agent target when volume overrides apply (e.g., "100 ideas" raises it, "top 3" may lower the survivor count instead).
3. Push past the safe obvious layer. Each agent's first few ideas tend to be obvious — push past them.
4. Ground every idea in the Phase 1 scan.
5. Use this prompting pattern as the backbone:
   - first generate many ideas
   - then challenge them systematically
   - then explain only the survivors in detail
6. If the platform supports sub-agents, use them to improve diversity in the candidate pool rather than to replace the core mechanism.
7. Give each ideation sub-agent the same:
   - grounding summary
   - focus hint
   - per-agent volume target (~7-8 ideas by default)
   - instruction to generate raw candidates only, not critique
8. When using sub-agents, assign each one a different ideation frame as a **starting bias, not a constraint**. Prompt each agent to begin from its assigned perspective but follow any promising thread wherever it leads — cross-cutting ideas that span multiple frames are valuable, not out of scope.

   **Frame selection depends on whether issue intelligence is active:**

   **When issue-tracker intent is active and themes were returned:**
   - Each theme with `confidence: high` or `confidence: medium` becomes an ideation frame. The frame prompt uses the theme title and description as the starting bias.
   - If fewer than 4 cluster-derived frames, pad with default frames in this order: "leverage and compounding effects", "assumption-breaking or reframing", "inversion, removal, or automation of a painful step". These complement issue-grounded themes by pushing beyond the reported problems.
   - Cap at 6 total frames. If more than 6 themes qualify, use the top 6 by issue count; note remaining themes in the grounding summary as "minor themes" so sub-agents are still aware of them.

   **When issue-tracker intent is NOT active (default):**
   - user or operator pain and friction
   - unmet need or missing capability
   - inversion, removal, or automation of a painful step
   - assumption-breaking or reframing
   - leverage and compounding effects
   - extreme cases, edge cases, or power-user pressure
9. Ask each ideation sub-agent to return a standardized structure for each idea so the orchestrator can merge and reason over the outputs consistently. Prefer a compact JSON-like structure with:
   - title
   - summary
   - why_it_matters
   - evidence or grounding hooks
   - optional local signals such as boldness or focus_fit
10. Merge and dedupe the sub-agent outputs into one master candidate list.
11. **Synthesize cross-cutting combinations.** After deduping, scan the merged list for ideas from different frames that together suggest something stronger than either alone. If two or more ideas naturally combine into a higher-leverage proposal, add the combined idea to the list (expect 3-5 additions at most). This synthesis step belongs to the orchestrator because it requires seeing all ideas simultaneously.
12. Spread ideas across multiple dimensions when justified:
   - workflow/DX
   - reliability
   - extensibility
   - missing capabilities
   - docs/knowledge compounding
   - quality and maintenance
   - leverage on future work
13. If a focus was provided, pass it to every ideation sub-agent and weight the merged list toward it without excluding stronger adjacent ideas.

The mechanism to preserve is:
- generate many ideas first
- critique the full combined list second
- explain only the survivors in detail

The sub-agent pattern to preserve is:
- independent ideation with frames as starting biases first
- orchestrator merge, dedupe, and cross-cutting synthesis second
- critique only after the combined and synthesized list exists

### Phase 3: Adversarial Filtering

Review every generated idea critically.

Prefer a two-layer critique:
1. Have one or more skeptical sub-agents attack the merged list from distinct angles.
2. Have the orchestrator synthesize those critiques, apply the rubric consistently, score the survivors, and decide the final ranking.

Do not let critique agents generate replacement ideas in this phase unless explicitly refining.

Critique agents may provide local judgments, but final scoring authority belongs to the orchestrator so the ranking stays consistent across different frames and perspectives.

For each rejected idea, write a one-line reason.

Use rejection criteria such as:
- too vague
- not actionable
- duplicates a stronger idea
- not grounded in the current codebase
- too expensive relative to likely value
- already covered by existing workflows or docs
- interesting but better handled as a brainstorm variant, not a product improvement

Use a consistent survivor rubric that weighs:
- groundedness in the current repo
- expected value
- novelty
- pragmatism
- leverage on future work
- implementation burden
- overlap with stronger ideas

Target output:
- keep 5-7 survivors by default
- if too many survive, run a second stricter pass
- if fewer than 5 survive, report that honestly rather than lowering the bar

### Phase 4: Present the Survivors

Present the surviving ideas to the user before writing the durable artifact.

This first presentation is a review checkpoint, not the final archived result.

Present only the surviving ideas in structured form:

- title
- description
- rationale
- downsides
- confidence score
- estimated complexity

Then include a brief rejection summary so the user can see what was considered and cut.

Keep the presentation concise. The durable artifact holds the full record.

Allow brief follow-up questions and lightweight clarification before writing the artifact.

Do not write the ideation doc yet unless:
- the user indicates the candidate set is good enough to preserve
- the user asks to refine and continue in a way that should be recorded
- the workflow is about to hand off to `ce:brainstorm`, Proof sharing, or session end

### Phase 5: Write the Ideation Artifact

Write the ideation artifact after the candidate set has been reviewed enough to preserve.

Always write or update the artifact before:
- handing off to `ce:brainstorm`
- sharing to Proof
- ending the session

To write the artifact:

1. Ensure `docs/ideation/` exists
2. Choose the file path:
   - `docs/ideation/YYYY-MM-DD-<topic>-ideation.md`
   - `docs/ideation/YYYY-MM-DD-open-ideation.md` when no focus exists
3. Write or update the ideation document

Use this structure and omit clearly irrelevant fields only when necessary:

```markdown
---
date: YYYY-MM-DD
topic: <kebab-case-topic>
focus: <optional focus hint>
---

# Ideation: <Title>

## Codebase Context
[Grounding summary from Phase 1]

## Ranked Ideas

### 1. <Idea Title>
**Description:** [Concrete explanation]
**Rationale:** [Why this improves the project]
**Downsides:** [Tradeoffs or costs]
**Confidence:** [0-100%]
**Complexity:** [Low / Medium / High]
**Status:** [Unexplored / Explored]

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | <Idea> | <Reason rejected> |

## Session Log
- YYYY-MM-DD: Initial ideation — <candidate count> generated, <survivor count> survived
```

If resuming:
- update the existing file in place
- append to the session log
- preserve explored markers

### Phase 6: Refine or Hand Off

After presenting the results, ask what should happen next.

Offer these options:
1. brainstorm a selected idea
2. refine the ideation
3. share to Proof
4. end the session

#### 6.1 Brainstorm a Selected Idea

If the user selects an idea:
- write or update the ideation doc first
- mark that idea as `Explored`
- note the brainstorm date in the session log
- invoke `ce:brainstorm` with the selected idea as the seed

Do **not** skip brainstorming and go straight to planning from ideation output.

#### 6.2 Refine the Ideation

Route refinement by intent:

- `add more ideas` or `explore new angles` -> return to Phase 2
- `re-evaluate` or `raise the bar` -> return to Phase 3
- `dig deeper on idea #N` -> expand only that idea's analysis

After each refinement:
- update the ideation document before any handoff, sharing, or session end
- append a session log entry

#### 6.3 Share to Proof

If requested, share the ideation document using the standard Proof markdown upload pattern already used elsewhere in the plugin.

Return to the next-step options after sharing.

#### 6.4 End the Session

When ending:
- offer to commit only the ideation doc
- do not create a branch
- do not push
- if the user declines, leave the file uncommitted

## Quality Bar

Before finishing, check:

- the idea set is grounded in the actual repo
- the candidate list was generated before filtering
- the original many-ideas -> critique -> survivors mechanism was preserved
- if sub-agents were used, they improved diversity without replacing the core workflow
- every rejected idea has a reason
- survivors are materially better than a naive "give me ideas" list
- the artifact was written before any handoff, sharing, or session end
- acting on an idea routes to `ce:brainstorm`, not directly to implementation
