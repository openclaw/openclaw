---
name: ce:plan
description: Transform feature descriptions into well-structured project plans following conventions
argument-hint: "[feature description, bug report, or improvement idea]"
---

# Create a plan for a new feature or bug fix

## Introduction

**Note: The current year is 2026.** Use this when dating plans and searching for recent documentation.

Transform feature descriptions, bug reports, or improvement ideas into well-structured markdown files issues that follow project conventions and best practices. This command provides flexible detail levels to match your needs.

## Feature Description

<feature_description> #$ARGUMENTS </feature_description>

**If the feature description above is empty, ask the user:** "What would you like to plan? Please describe the feature, bug fix, or improvement you have in mind."

Do not proceed until you have a clear feature description from the user.

### 0. Idea Refinement

**Check for requirements document first:**

Before asking questions, look for recent requirements documents in `docs/brainstorms/` that match this feature:

```bash
ls -la docs/brainstorms/*-requirements.md 2>/dev/null | head -10
```

**Relevance criteria:** A requirements document is relevant if:
- The topic (from filename or YAML frontmatter) semantically matches the feature description
- Created within the last 14 days
- If multiple candidates match, use the most recent one

**If a relevant requirements document exists:**
1. Read the source document **thoroughly** — every section matters
2. Announce: "Found source document from [date]: [topic]. Using as foundation for planning."
3. Extract and carry forward **ALL** of the following into the plan:
   - Key decisions and their rationale
   - Chosen approach and why alternatives were rejected
   - Problem framing, constraints, and requirements captured during brainstorming
   - Outstanding questions, preserving whether they block planning or are intentionally deferred
   - Success criteria and scope boundaries
   - Dependencies and assumptions, plus any high-level technical direction only when the origin document is inherently technical
4. **Skip the idea refinement questions below** — the source document already answered WHAT to build
5. Use source document content as the **primary input** to research and planning phases
6. **Critical: The source document is the origin document.** Throughout the plan, reference specific decisions with `(see origin: <source-path>)` when carrying forward conclusions. Do not paraphrase decisions in a way that loses their original context — link back to the source.
7. **Do not omit source content** — if the source document discussed it, the plan must address it (even if briefly). Scan each section before finalizing the plan to verify nothing was dropped.
8. **If `Resolve Before Planning` contains any items, stop.** Do not proceed with planning. Tell the user planning is blocked by unanswered brainstorm questions and direct them to resume `/ce:brainstorm` or answer those questions first.

**If multiple source documents could match:**
Use **AskUserQuestion tool** to ask which source document to use, or whether to proceed without one.

**If no requirements document is found (or not relevant), run idea refinement:**

Refine the idea through collaborative dialogue using the **AskUserQuestion tool**:

- Ask questions one at a time to understand the idea fully
- Prefer multiple choice questions when natural options exist
- Focus on understanding: purpose, constraints and success criteria
- Continue until the idea is clear OR user says "proceed"

**Gather signals for research decision.** During refinement, note:

- **User's familiarity**: Do they know the codebase patterns? Are they pointing to examples?
- **User's intent**: Speed vs thoroughness? Exploration vs execution?
- **Topic risk**: Security, payments, external APIs warrant more caution
- **Uncertainty level**: Is the approach clear or open-ended?

**Skip option:** If the feature description is already detailed, offer:
"Your description is clear. Should I proceed with research, or would you like to refine it further?"

## Main Tasks

### 1. Local Research (Always Runs - Parallel)

<thinking>
First, I need to understand the project's conventions, existing patterns, and any documented learnings. This is fast and local - it informs whether external research is needed.
</thinking>

Run these agents **in parallel** to gather local context:

- Task compound-engineering:research:repo-research-analyst(feature_description)
- Task compound-engineering:research:learnings-researcher(feature_description)

**What to look for:**
- **Repo research:** existing patterns, AGENTS.md guidance, technology familiarity, pattern consistency
- **Learnings:** documented solutions in `docs/solutions/` that might apply (gotchas, patterns, lessons learned)

These findings inform the next step.

### 1.5. Research Decision

Based on signals from Step 0 and findings from Step 1, decide on external research.

**High-risk topics → always research.** Security, payments, external APIs, data privacy. The cost of missing something is too high. This takes precedence over speed signals.

**Strong local context -> skip external research.** Codebase has good patterns, AGENTS.md has guidance, user knows what they want. External research adds little value.

**Uncertainty or unfamiliar territory → research.** User is exploring, codebase has no examples, new technology. External perspective is valuable.

**Announce the decision and proceed.** Brief explanation, then continue. User can redirect if needed.

Examples:
- "Your codebase has solid patterns for this. Proceeding without external research."
- "This involves payment processing, so I'll research current best practices first."

### 1.5b. External Research (Conditional)

**Only run if Step 1.5 indicates external research is valuable.**

Run these agents in parallel:

- Task compound-engineering:research:best-practices-researcher(feature_description)
- Task compound-engineering:research:framework-docs-researcher(feature_description)

### 1.6. Consolidate Research

After all research steps complete, consolidate findings:

- Document relevant file paths from repo research (e.g., `app/services/example_service.rb:42`)
- **Include relevant institutional learnings** from `docs/solutions/` (key insights, gotchas to avoid)
- Note external documentation URLs and best practices (if external research was done)
- List related issues or PRs discovered
- Capture AGENTS.md conventions

**Optional validation:** Briefly summarize findings and ask if anything looks off or missing before proceeding to planning.

### 2. Issue Planning & Structure

<thinking>
Think like a product manager - what would make this issue clear and actionable? Consider multiple perspectives
</thinking>

**Title & Categorization:**

- [ ] Draft clear, searchable issue title using conventional format (e.g., `feat: Add user authentication`, `fix: Cart total calculation`)
- [ ] Determine issue type: enhancement, bug, refactor
- [ ] Convert title to filename: add today's date prefix, determine daily sequence number, strip prefix colon, kebab-case, add `-plan` suffix
  - Scan `docs/plans/` for files matching today's date pattern `YYYY-MM-DD-\d{3}-`
  - Find the highest existing sequence number for today
  - Increment by 1, zero-padded to 3 digits (001, 002, etc.)
  - Example: `feat: Add User Authentication` → `2026-01-21-001-feat-add-user-authentication-plan.md`
  - Keep it descriptive (3-5 words after prefix) so plans are findable by context

**Stakeholder Analysis:**

- [ ] Identify who will be affected by this issue (end users, developers, operations)
- [ ] Consider implementation complexity and required expertise

**Content Planning:**

- [ ] Choose appropriate detail level based on issue complexity and audience
- [ ] List all necessary sections for the chosen template
- [ ] Gather supporting materials (error logs, screenshots, design mockups)
- [ ] Prepare code examples or reproduction steps if applicable, name the mock filenames in the lists

### 3. SpecFlow Analysis

After planning the issue structure, run SpecFlow Analyzer to validate and refine the feature specification:

- Task compound-engineering:workflow:spec-flow-analyzer(feature_description, research_findings)

**SpecFlow Analyzer Output:**

- [ ] Review SpecFlow analysis results
- [ ] Incorporate any identified gaps or edge cases into the issue
- [ ] Update acceptance criteria based on SpecFlow findings

### 4. Choose Implementation Detail Level

Select how comprehensive you want the issue to be, simpler is mostly better.

#### 📄 MINIMAL (Quick Issue)

**Best for:** Simple bugs, small improvements, clear features

**Includes:**

- Problem statement or feature description
- Basic acceptance criteria
- Essential context only

**Structure:**

````markdown
---
title: [Issue Title]
type: [feat|fix|refactor]
status: active
date: YYYY-MM-DD
origin: docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md  # if originated from a requirements doc, otherwise omit
---

# [Issue Title]

[Brief problem/feature description]

## Acceptance Criteria

- [ ] Core requirement 1
- [ ] Core requirement 2

## Context

[Any critical information]

## MVP

### test.rb

```ruby
class Test
  def initialize
    @name = "test"
  end
end
```

## Sources

- **Origin document:** [docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md](path) — include if plan originated from an upstream requirements doc
- Related issue: #[issue_number]
- Documentation: [relevant_docs_url]
````

#### 📋 MORE (Standard Issue)

**Best for:** Most features, complex bugs, team collaboration

**Includes everything from MINIMAL plus:**

- Detailed background and motivation
- Technical considerations
- Success metrics
- Dependencies and risks
- Basic implementation suggestions

**Structure:**

```markdown
---
title: [Issue Title]
type: [feat|fix|refactor]
status: active
date: YYYY-MM-DD
origin: docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md  # if originated from a requirements doc, otherwise omit
---

# [Issue Title]

## Overview

[Comprehensive description]

## Problem Statement / Motivation

[Why this matters]

## Proposed Solution

[High-level approach]

## Technical Considerations

- Architecture impacts
- Performance implications
- Security considerations

## System-Wide Impact

- **Interaction graph**: [What callbacks/middleware/observers fire when this runs?]
- **Error propagation**: [How do errors flow across layers? Do retry strategies align?]
- **State lifecycle risks**: [Can partial failure leave orphaned/inconsistent state?]
- **API surface parity**: [What other interfaces expose similar functionality and need the same change?]
- **Integration test scenarios**: [Cross-layer scenarios that unit tests won't catch]

## Acceptance Criteria

- [ ] Detailed requirement 1
- [ ] Detailed requirement 2
- [ ] Testing requirements

## Success Metrics

[How we measure success]

## Dependencies & Risks

[What could block or complicate this]

## Sources & References

- **Origin document:** [docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md](path) — include if plan originated from an upstream requirements doc
- Similar implementations: [file_path:line_number]
- Best practices: [documentation_url]
- Related PRs: #[pr_number]
```

#### 📚 A LOT (Comprehensive Issue)

**Best for:** Major features, architectural changes, complex integrations

**Includes everything from MORE plus:**

- Detailed implementation plan with phases
- Alternative approaches considered
- Extensive technical specifications
- Resource requirements and timeline
- Future considerations and extensibility
- Risk mitigation strategies
- Documentation requirements

**Structure:**

```markdown
---
title: [Issue Title]
type: [feat|fix|refactor]
status: active
date: YYYY-MM-DD
origin: docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md  # if originated from a requirements doc, otherwise omit
---

# [Issue Title]

## Overview

[Executive summary]

## Problem Statement

[Detailed problem analysis]

## Proposed Solution

[Comprehensive solution design]

## Technical Approach

### Architecture

[Detailed technical design]

### Implementation Phases

#### Phase 1: [Foundation]

- Tasks and deliverables
- Success criteria
- Estimated effort

#### Phase 2: [Core Implementation]

- Tasks and deliverables
- Success criteria
- Estimated effort

#### Phase 3: [Polish & Optimization]

- Tasks and deliverables
- Success criteria
- Estimated effort

## Alternative Approaches Considered

[Other solutions evaluated and why rejected]

## System-Wide Impact

### Interaction Graph

[Map the chain reaction: what callbacks, middleware, observers, and event handlers fire when this code runs? Trace at least two levels deep. Document: "Action X triggers Y, which calls Z, which persists W."]

### Error & Failure Propagation

[Trace errors from lowest layer up. List specific error classes and where they're handled. Identify retry conflicts, unhandled error types, and silent failure swallowing.]

### State Lifecycle Risks

[Walk through each step that persists state. Can partial failure orphan rows, duplicate records, or leave caches stale? Document cleanup mechanisms or their absence.]

### API Surface Parity

[List all interfaces (classes, DSLs, endpoints) that expose equivalent functionality. Note which need updating and which share the code path.]

### Integration Test Scenarios

[3-5 cross-layer test scenarios that unit tests with mocks would never catch. Include expected behavior for each.]

## Acceptance Criteria

### Functional Requirements

- [ ] Detailed functional criteria

### Non-Functional Requirements

- [ ] Performance targets
- [ ] Security requirements
- [ ] Accessibility standards

### Quality Gates

- [ ] Test coverage requirements
- [ ] Documentation completeness
- [ ] Code review approval

## Success Metrics

[Detailed KPIs and measurement methods]

## Dependencies & Prerequisites

[Detailed dependency analysis]

## Risk Analysis & Mitigation

[Comprehensive risk assessment]

## Resource Requirements

[Team, time, infrastructure needs]

## Future Considerations

[Extensibility and long-term vision]

## Documentation Plan

[What docs need updating]

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md](path) — include if plan originated from an upstream requirements doc. Key decisions carried forward: [list 2-3 major decisions from the origin]

### Internal References

- Architecture decisions: [file_path:line_number]
- Similar features: [file_path:line_number]
- Configuration: [file_path:line_number]

### External References

- Framework documentation: [url]
- Best practices guide: [url]
- Industry standards: [url]

### Related Work

- Previous PRs: #[pr_numbers]
- Related issues: #[issue_numbers]
- Design documents: [links]
```

### 5. Issue Creation & Formatting

<thinking>
Apply best practices for clarity and actionability, making the issue easy to scan and understand
</thinking>

**Content Formatting:**

- [ ] Use clear, descriptive headings with proper hierarchy (##, ###)
- [ ] Include code examples in triple backticks with language syntax highlighting
- [ ] Add screenshots/mockups if UI-related (drag & drop or use image hosting)
- [ ] Use task lists (- [ ]) for trackable items that can be checked off
- [ ] Add collapsible sections for lengthy logs or optional details using `<details>` tags
- [ ] Apply appropriate emoji for visual scanning (🐛 bug, ✨ feature, 📚 docs, ♻️ refactor)

**Cross-Referencing:**

- [ ] Link to related issues/PRs using #number format
- [ ] Reference specific commits with SHA hashes when relevant
- [ ] Link to code using GitHub's permalink feature (press 'y' for permanent link)
- [ ] Mention relevant team members with @username if needed
- [ ] Add links to external resources with descriptive text

**Code & Examples:**

````markdown
# Good example with syntax highlighting and line references


```ruby
# app/services/user_service.rb:42
def process_user(user)

# Implementation here

end
```

# Collapsible error logs

<details>
<summary>Full error stacktrace</summary>

`Error details here...`

</details>
````

**AI-Era Considerations:**

- [ ] Account for accelerated development with AI pair programming
- [ ] Include prompts or instructions that worked well during research
- [ ] Note which AI tools were used for initial exploration (Claude, Copilot, etc.)
- [ ] Emphasize comprehensive testing given rapid implementation
- [ ] Document any AI-generated code that needs human review

### 6. Final Review & Submission

**Origin document cross-check (if plan originated from a requirements doc):**

Before finalizing, re-read the origin document and verify:
- [ ] Every key decision from the origin document is reflected in the plan
- [ ] The chosen approach matches what was decided in the origin document
- [ ] Constraints and requirements from the origin document are captured in acceptance criteria
- [ ] Open questions from the origin document are either resolved or flagged
- [ ] The `origin:` frontmatter field points to the correct source file
- [ ] The Sources section includes the origin document with a summary of carried-forward decisions

**Pre-submission Checklist:**

- [ ] Title is searchable and descriptive
- [ ] Labels accurately categorize the issue
- [ ] All template sections are complete
- [ ] Links and references are working
- [ ] Acceptance criteria are measurable
- [ ] Add names of files in pseudo code examples and todo lists
- [ ] Add an ERD mermaid diagram if applicable for new model changes

## Write Plan File

**REQUIRED: Write the plan file to disk before presenting any options.**

```bash
mkdir -p docs/plans/
# Determine daily sequence number
today=$(date +%Y-%m-%d)
last_seq=$(ls docs/plans/${today}-*-plan.md 2>/dev/null | grep -oP "${today}-\K\d{3}" | sort -n | tail -1)
next_seq=$(printf "%03d" $(( ${last_seq:-0} + 1 )))
```

Use the Write tool to save the complete plan to `docs/plans/YYYY-MM-DD-NNN-<type>-<descriptive-name>-plan.md` (where NNN is `$next_seq` from the bash command above). This step is mandatory and cannot be skipped — even when running as part of LFG/SLFG or other automated pipelines.

Confirm: "Plan written to docs/plans/[filename]"

**Pipeline mode:** If invoked from an automated workflow (LFG, SLFG, or any `disable-model-invocation` context), skip all AskUserQuestion calls. Make decisions automatically and proceed to writing the plan without interactive prompts.

## Output Format

**Filename:** Use the date, daily sequence number, and kebab-case filename from Step 2 Title & Categorization.

```
docs/plans/YYYY-MM-DD-NNN-<type>-<descriptive-name>-plan.md
```

Examples:
- ✅ `docs/plans/2026-01-15-001-feat-user-authentication-flow-plan.md`
- ✅ `docs/plans/2026-02-03-001-fix-checkout-race-condition-plan.md`
- ✅ `docs/plans/2026-03-10-002-refactor-api-client-extraction-plan.md`
- ❌ `docs/plans/2026-01-15-feat-thing-plan.md` (missing sequence number, not descriptive)
- ❌ `docs/plans/2026-01-15-001-feat-new-feature-plan.md` (too vague - what feature?)
- ❌ `docs/plans/2026-01-15-001-feat: user auth-plan.md` (invalid characters - colon and space)
- ❌ `docs/plans/feat-user-auth-plan.md` (missing date prefix and sequence number)

## Post-Generation Options

After writing the plan file, use the **AskUserQuestion tool** to present these options:

**Question:** "Plan ready at `docs/plans/YYYY-MM-DD-NNN-<type>-<name>-plan.md`. What would you like to do next?"

**Options:**
1. **Open plan in editor** - Open the plan file for review
2. **Run `/deepen-plan`** - Enhance each section with parallel research agents (best practices, performance, UI)
3. **Review and refine** - Improve the document through structured self-review
4. **Share to Proof** - Upload to Proof for collaborative review and sharing
5. **Start `/ce:work`** - Begin implementing this plan locally
6. **Start `/ce:work` on remote** - Begin implementing in Claude Code on the web (use `&` to run in background)
7. **Create Issue** - Create issue in project tracker (GitHub/Linear)

Based on selection:
- **Open plan in editor** → Run `open docs/plans/<plan_filename>.md` to open the file in the user's default editor
- **`/deepen-plan`** → Call the /deepen-plan command with the plan file path to enhance with research
- **Review and refine** → Load `document-review` skill.
- **Share to Proof** → Upload the plan to Proof:
  ```bash
  CONTENT=$(cat docs/plans/<plan_filename>.md)
  TITLE="Plan: <plan title from frontmatter>"
  RESPONSE=$(curl -s -X POST https://www.proofeditor.ai/share/markdown \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg title "$TITLE" --arg markdown "$CONTENT" --arg by "ai:compound" '{title: $title, markdown: $markdown, by: $by}')")
  PROOF_URL=$(echo "$RESPONSE" | jq -r '.tokenUrl')
  ```
  Display: `View & collaborate in Proof: <PROOF_URL>` — skip silently if curl fails. Then return to options.
- **`/ce:work`** → Call the /ce:work command with the plan file path
- **`/ce:work` on remote** → Run `/ce:work docs/plans/<plan_filename>.md &` to start work in background for Claude Code web
- **Create Issue** → See "Issue Creation" section below
- **Other** (automatically provided) → Accept free text for rework or specific changes

**Note:** If running `/ce:plan` with ultrathink enabled, automatically run `/deepen-plan` after plan creation for maximum depth and grounding.

Loop back to options after Simplify or Other changes until user selects `/ce:work` or another action.

## Issue Creation

When user selects "Create Issue", detect their project tracker from AGENTS.md:

1. **Check for tracker preference** in the user's AGENTS.md (global or project). If AGENTS.md is absent, fall back to CLAUDE.md:
   - Look for `project_tracker: github` or `project_tracker: linear`
   - Or look for mentions of "GitHub Issues" or "Linear" in their workflow section

2. **If GitHub:**

   Use the title and type from Step 2 (already in context - no need to re-read the file):

   ```bash
   gh issue create --title "<type>: <title>" --body-file <plan_path>
   ```

3. **If Linear:**

   ```bash
   linear issue create --title "<title>" --description "$(cat <plan_path>)"
   ```

4. **If no tracker configured:**
   Ask user: "Which project tracker do you use? (GitHub/Linear/Other)"
   - Suggest adding `project_tracker: github` or `project_tracker: linear` to their AGENTS.md

5. **After creation:**
   - Display the issue URL
   - Ask if they want to proceed to `/ce:work`

NEVER CODE! Just research and write the plan.
