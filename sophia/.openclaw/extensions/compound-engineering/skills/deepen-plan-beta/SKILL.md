---
name: deepen-plan-beta
description: "[BETA] Stress-test an existing implementation plan and selectively strengthen weak sections with targeted research. Use when a plan needs more confidence around decisions, sequencing, system-wide impact, risks, or verification. Best for Standard or Deep plans, or high-risk topics such as auth, payments, migrations, external APIs, and security. For structural or clarity improvements, prefer document-review instead."
argument-hint: "[path to plan file]"
disable-model-invocation: true
---

# Deepen Plan

## Introduction

**Note: The current year is 2026.** Use this when searching for recent documentation and best practices.

`ce:plan-beta` does the first planning pass. `deepen-plan-beta` is a second-pass confidence check.

Use this skill when the plan already exists and the question is not "Is this document clear?" but rather "Is this plan grounded enough for the complexity and risk involved?"

This skill does **not** turn plans into implementation scripts. It identifies weak sections, runs targeted research only for those sections, and strengthens the plan in place.

`document-review` and `deepen-plan-beta` are different:
- Use the `document-review` skill when the document needs clarity, simplification, completeness, or scope control
- Use `deepen-plan-beta` when the document is structurally sound but still needs stronger rationale, sequencing, risk treatment, or system-wide thinking

## Interaction Method

Use the platform's question tool when available. When asking the user a question, prefer the platform's blocking question tool if one exists (`AskUserQuestion` in Claude Code, `request_user_input` in Codex, `ask_user` in Gemini). Otherwise, present numbered options in chat and wait for the user's reply before proceeding.

Ask one question at a time. Prefer a concise single-select choice when natural options exist.

## Plan File

<plan_path> #$ARGUMENTS </plan_path>

If the plan path above is empty:
1. Check `docs/plans/` for recent files
2. Ask the user which plan to deepen using the platform's blocking question tool when available (see Interaction Method). Otherwise, present numbered options in chat and wait for the user's reply before proceeding

Do not proceed until you have a valid plan file path.

## Core Principles

1. **Stress-test, do not inflate** - Deepening should increase justified confidence, not make the plan longer for its own sake.
2. **Selective depth only** - Focus on the weakest 2-5 sections rather than enriching everything.
3. **Preserve the planning boundary** - No implementation code, no git command choreography, no exact test command recipes.
4. **Use artifact-contained evidence** - Work from the written plan, its `Context & Research`, `Sources & References`, and its origin document when present.
5. **Respect product boundaries** - Do not invent new product requirements. If deepening reveals a product-level gap, surface it as an open question or route back to `ce:brainstorm`.
6. **Prioritize risk and cross-cutting impact** - The more dangerous or interconnected the work, the more valuable another planning pass becomes.

## Workflow

### Phase 0: Load the Plan and Decide Whether Deepening Is Warranted

#### 0.1 Read the Plan and Supporting Inputs

Read the plan file completely.

If the plan frontmatter includes an `origin:` path:
- Read the origin document too
- Use it to check whether the plan still reflects the product intent, scope boundaries, and success criteria

#### 0.2 Classify Plan Depth and Topic Risk

Determine the plan depth from the document:
- **Lightweight** - small, bounded, low ambiguity, usually 2-4 implementation units
- **Standard** - moderate complexity, some technical decisions, usually 3-6 units
- **Deep** - cross-cutting, high-risk, or strategically important work, usually 4-8 units or phased delivery

Also build a risk profile. Treat these as high-risk signals:
- Authentication, authorization, or security-sensitive behavior
- Payments, billing, or financial flows
- Data migrations, backfills, or persistent data changes
- External APIs or third-party integrations
- Privacy, compliance, or user data handling
- Cross-interface parity or multi-surface behavior
- Significant rollout, monitoring, or operational concerns

#### 0.3 Decide Whether to Deepen

Use this default:
- **Lightweight** plans usually do not need deepening unless they are high-risk or the user explicitly requests it
- **Standard** plans often benefit when one or more important sections still look thin
- **Deep** or high-risk plans often benefit from a targeted second pass

If the plan already appears sufficiently grounded:
- Say so briefly
- Recommend moving to `/ce:work` or the `document-review` skill
- If the user explicitly asked to deepen anyway, continue with a light pass and deepen at most 1-2 sections

### Phase 1: Parse the Current `ce:plan-beta` Structure

Map the plan into the current template. Look for these sections, or their nearest equivalents:
- `Overview`
- `Problem Frame`
- `Requirements Trace`
- `Scope Boundaries`
- `Context & Research`
- `Key Technical Decisions`
- `Open Questions`
- `High-Level Technical Design` (optional overview — pseudo-code, DSL grammar, mermaid diagram, or data flow)
- `Implementation Units` (may include per-unit `Technical design` subsections)
- `System-Wide Impact`
- `Risks & Dependencies`
- `Documentation / Operational Notes`
- `Sources & References`
- Optional deep-plan sections such as `Alternative Approaches Considered`, `Success Metrics`, `Phased Delivery`, `Risk Analysis & Mitigation`, and `Operational / Rollout Notes`

If the plan was written manually or uses different headings:
- Map sections by intent rather than exact heading names
- If a section is structurally present but titled differently, treat it as the equivalent section
- If the plan truly lacks a section, decide whether that absence is intentional for the plan depth or a confidence gap worth scoring

Also collect:
- Frontmatter, including existing `deepened:` date if present
- Number of implementation units
- Which files and test files are named
- Which learnings, patterns, or external references are cited
- Which sections appear omitted because they were unnecessary versus omitted because they are missing

### Phase 2: Score Confidence Gaps

Use a checklist-first, risk-weighted scoring pass.

For each section, compute:
- **Trigger count** - number of checklist problems that apply
- **Risk bonus** - add 1 if the topic is high-risk and this section is materially relevant to that risk
- **Critical-section bonus** - add 1 for `Key Technical Decisions`, `Implementation Units`, `System-Wide Impact`, `Risks & Dependencies`, or `Open Questions` in `Standard` or `Deep` plans

Treat a section as a candidate if:
- it hits **2+ total points**, or
- it hits **1+ point** in a high-risk domain and the section is materially important

Choose only the top **2-5** sections by score. If the user explicitly asked to deepen a lightweight plan, cap at **1-2** sections unless the topic is high-risk.

Example:
- A `Key Technical Decisions` section with 1 checklist trigger and the critical-section bonus scores **2 points** and is a candidate
- A `Risks & Dependencies` section with 1 checklist trigger in a high-risk migration plan also becomes a candidate because the risk bonus applies

If the plan already has a `deepened:` date:
- Prefer sections that have not yet been substantially strengthened, if their scores are comparable
- Revisit an already-deepened section only when it still scores clearly higher than alternatives or the user explicitly asks for another pass on it

#### 2.1 Section Checklists

Use these triggers.

**Requirements Trace**
- Requirements are vague or disconnected from implementation units
- Success criteria are missing or not reflected downstream
- Units do not clearly advance the traced requirements
- Origin requirements are not clearly carried forward

**Context & Research / Sources & References**
- Relevant repo patterns are named but never used in decisions or implementation units
- Cited learnings or references do not materially shape the plan
- High-risk work lacks appropriate external or internal grounding
- Research is generic instead of tied to this repo or this plan

**Key Technical Decisions**
- A decision is stated without rationale
- Rationale does not explain tradeoffs or rejected alternatives
- The decision does not connect back to scope, requirements, or origin context
- An obvious design fork exists but the plan never addresses why one path won

**Open Questions**
- Product blockers are hidden as assumptions
- Planning-owned questions are incorrectly deferred to implementation
- Resolved questions have no clear basis in repo context, research, or origin decisions
- Deferred items are too vague to be useful later

**High-Level Technical Design (when present)**
- The sketch uses the wrong medium for the work (e.g., pseudo-code where a sequence diagram would communicate better)
- The sketch contains implementation code (imports, exact signatures, framework-specific syntax) rather than pseudo-code
- The non-prescriptive framing is missing or weak
- The sketch does not connect to the key technical decisions or implementation units

**High-Level Technical Design (when absent)** *(Standard or Deep plans only)*
- The work involves DSL design, API surface design, multi-component integration, complex data flow, or state-heavy lifecycle
- Key technical decisions would be easier to validate with a visual or pseudo-code representation
- The approach section of implementation units is thin and a higher-level technical design would provide context

**Implementation Units**
- Dependency order is unclear or likely wrong
- File paths or test file paths are missing where they should be explicit
- Units are too large, too vague, or broken into micro-steps
- Approach notes are thin or do not name the pattern to follow
- Test scenarios or verification outcomes are vague

**System-Wide Impact**
- Affected interfaces, callbacks, middleware, entry points, or parity surfaces are missing
- Failure propagation is underexplored
- State lifecycle, caching, or data integrity risks are absent where relevant
- Integration coverage is weak for cross-layer work

**Risks & Dependencies / Documentation / Operational Notes**
- Risks are listed without mitigation
- Rollout, monitoring, migration, or support implications are missing when warranted
- External dependency assumptions are weak or unstated
- Security, privacy, performance, or data risks are absent where they obviously apply

Use the plan's own `Context & Research` and `Sources & References` as evidence. If those sections cite a pattern, learning, or risk that never affects decisions, implementation units, or verification, treat that as a confidence gap.

### Phase 3: Select Targeted Research Agents

For each selected section, choose the smallest useful agent set. Do **not** run every agent. Use at most **1-3 agents per section** and usually no more than **8 agents total**.

Use fully-qualified agent names inside Task calls.

#### 3.1 Deterministic Section-to-Agent Mapping

**Requirements Trace / Open Questions classification**
- `compound-engineering:workflow:spec-flow-analyzer` for missing user flows, edge cases, and handoff gaps
- `compound-engineering:research:repo-research-analyst` for repo-grounded patterns, conventions, and implementation reality checks

**Context & Research / Sources & References gaps**
- `compound-engineering:research:learnings-researcher` for institutional knowledge and past solved problems
- `compound-engineering:research:framework-docs-researcher` for official framework or library behavior
- `compound-engineering:research:best-practices-researcher` for current external patterns and industry guidance
- Add `compound-engineering:research:git-history-analyzer` only when historical rationale or prior art is materially missing

**Key Technical Decisions**
- `compound-engineering:review:architecture-strategist` for design integrity, boundaries, and architectural tradeoffs
- Add `compound-engineering:research:framework-docs-researcher` or `compound-engineering:research:best-practices-researcher` when the decision needs external grounding beyond repo evidence

**High-Level Technical Design**
- `compound-engineering:review:architecture-strategist` for validating that the technical design accurately represents the intended approach and identifying gaps
- `compound-engineering:research:repo-research-analyst` for grounding the technical design in existing repo patterns and conventions
- Add `compound-engineering:research:best-practices-researcher` when the technical design involves a DSL, API surface, or pattern that benefits from external validation

**Implementation Units / Verification**
- `compound-engineering:research:repo-research-analyst` for concrete file targets, patterns to follow, and repo-specific sequencing clues
- `compound-engineering:review:pattern-recognition-specialist` for consistency, duplication risks, and alignment with existing patterns
- Add `compound-engineering:workflow:spec-flow-analyzer` when sequencing depends on user flow or handoff completeness

**System-Wide Impact**
- `compound-engineering:review:architecture-strategist` for cross-boundary effects, interface surfaces, and architectural knock-on impact
- Add the specific specialist that matches the risk:
  - `compound-engineering:review:performance-oracle` for scalability, latency, throughput, and resource-risk analysis
  - `compound-engineering:review:security-sentinel` for auth, validation, exploit surfaces, and security boundary review
  - `compound-engineering:review:data-integrity-guardian` for migrations, persistent state safety, consistency, and data lifecycle risks

**Risks & Dependencies / Operational Notes**
- Use the specialist that matches the actual risk:
  - `compound-engineering:review:security-sentinel` for security, auth, privacy, and exploit risk
  - `compound-engineering:review:data-integrity-guardian` for persistent data safety, constraints, and transaction boundaries
  - `compound-engineering:review:data-migration-expert` for migration realism, backfills, and production data transformation risk
  - `compound-engineering:review:deployment-verification-agent` for rollout checklists, rollback planning, and launch verification
  - `compound-engineering:review:performance-oracle` for capacity, latency, and scaling concerns

#### 3.2 Agent Prompt Shape

For each selected section, pass:
- A short plan summary
- The exact section text
- Why the section was selected, including which checklist triggers fired
- The plan depth and risk profile
- A specific question to answer

Instruct the agent to return:
- findings that change planning quality
- stronger rationale, sequencing, verification, risk treatment, or references
- no implementation code
- no shell commands

### Phase 4: Run Targeted Research and Review

Launch the selected agents in parallel.

Prefer local repo and institutional evidence first. Use external research only when the gap cannot be closed responsibly from repo context or already-cited sources.

If a selected section can be improved by reading the origin document more carefully, do that before dispatching external agents.

If agent outputs conflict:
- Prefer repo-grounded and origin-grounded evidence over generic advice
- Prefer official framework documentation over secondary best-practice summaries when the conflict is about library behavior
- If a real tradeoff remains, record it explicitly in the plan rather than pretending the conflict does not exist

### Phase 5: Synthesize and Rewrite the Plan

Strengthen only the selected sections. Keep the plan coherent and preserve its overall structure.

Allowed changes:
- Clarify or strengthen decision rationale
- Tighten requirements trace or origin fidelity
- Reorder or split implementation units when sequencing is weak
- Add missing pattern references, file/test paths, or verification outcomes
- Expand system-wide impact, risks, or rollout treatment where justified
- Reclassify open questions between `Resolved During Planning` and `Deferred to Implementation` when evidence supports the change
- Strengthen, replace, or add a High-Level Technical Design section when the work warrants it and the current representation is weak, uses the wrong medium, or is absent where it would help. Preserve the non-prescriptive framing
- Strengthen or add per-unit technical design fields where the unit's approach is non-obvious and the current approach notes are thin
- Add an optional deep-plan section only when it materially improves execution quality
- Add or update `deepened: YYYY-MM-DD` in frontmatter when the plan was substantively improved

Do **not**:
- Add implementation code — no imports, exact method signatures, or framework-specific syntax. Pseudo-code sketches and DSL grammars are allowed in both the top-level High-Level Technical Design section and per-unit technical design fields
- Add git commands, commit choreography, or exact test command recipes
- Add generic `Research Insights` subsections everywhere
- Rewrite the entire plan from scratch
- Invent new product requirements, scope changes, or success criteria without surfacing them explicitly

If research reveals a product-level ambiguity that should change behavior or scope:
- Do not silently decide it here
- Record it under `Open Questions`
- Recommend `ce:brainstorm` if the gap is truly product-defining

### Phase 6: Final Checks and Write the File

Before writing:
- Confirm the plan is stronger in specific ways, not merely longer
- Confirm the planning boundary is intact
- Confirm the selected sections were actually the weakest ones
- Confirm origin decisions were preserved when an origin document exists
- Confirm the final plan still feels right-sized for its depth

Update the plan file in place by default.

If the user explicitly requests a separate file, append `-deepened` before `.md`, for example:
- `docs/plans/2026-03-15-001-feat-example-plan-deepened.md`

## Post-Enhancement Options

If substantive changes were made, present next steps using the platform's blocking question tool when available (see Interaction Method). Otherwise, present numbered options in chat and wait for the user's reply before proceeding.

**Question:** "Plan deepened at `[plan_path]`. What would you like to do next?"

**Options:**
1. **View diff** - Show what changed
2. **Run `document-review` skill** - Improve the updated plan through structured document review
3. **Start `ce:work` skill** - Begin implementing the plan
4. **Deepen specific sections further** - Run another targeted deepening pass on named sections

Based on selection:
- **View diff** -> Show the important additions and changed sections
- **`document-review` skill** -> Load the `document-review` skill with the plan path
- **Start `ce:work` skill** -> Call the `ce:work` skill with the plan path
- **Deepen specific sections further** -> Ask which sections still feel weak and run another targeted pass only for those sections

If no substantive changes were warranted:
- Say that the plan already appears sufficiently grounded
- Offer the `document-review` skill or `/ce:work` as the next step instead

NEVER CODE! Research, challenge, and strengthen the plan.
