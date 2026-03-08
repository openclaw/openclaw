# Phase 1: Identity & Governance Foundation - Research

**Researched:** 2026-03-08
**Domain:** AI governance frameworks, constitutional AI, agent identity templates, behavioral rules
**Confidence:** HIGH

---

## Summary

Phase 1 establishes the governing doctrine for FrankOS — six documents that all agents load at boot time and apply in every decision. This is not theoretical governance; it is machine-readable constitution that agents actually consult.

Existing FrankOS already has a `10_Constitution/` directory with partial governance documents (Engineering-Constitution.md, Memory-Constitution.md, Autonomy-Budget.md, etc.) and `11_Agents/` with agent specs. The BOOT.md already references loading "Constitution Policies" in Step 2 and "Agent Specification" in Step 3. Phase 1 is therefore an enhancement and consolidation, not a blank-slate build.

The standard approach for AI governance follows a strict document hierarchy: Mission (why we exist) → Constitution (inviolable principles) → Operator Charter (role and authority boundaries) → Working Principles (behavioral rules) → Memory Constitution (knowledge rules) → Agent Identity (persona templates). Each layer is more specific and operational than the one above it. Industry convergence (Anthropic, OpenAI, IMDA, IEEE 7000) shows that rule-based systems alone fail; reason-based systems that explain the "why" behind rules perform better because agents can generalize to novel situations.

**Primary recommendation:** Structure the six governance documents as a coherent stack where each document references the one above it. All documents must be written assuming agents — not humans — read them at runtime. Rules must be concrete and evaluable, not aspirational.

---

## Standard Governance Frameworks

### What Industry Has Converged On

The field has moved from rule-based to reason-based governance. Anthropic published Claude's full constitution on January 22, 2026 under Creative Commons. It establishes a 4-tier priority hierarchy:

1. Broadly safe (human oversight preserved)
2. Broadly ethical (honest, avoids harm)
3. Compliant with guidelines (organizational directives)
4. Genuinely helpful (benefits operators and users)

This maps directly to the FrankOS hierarchy: Mission → Constitution → Safety → Principles → Project → Task.

### Document Hierarchy (Standard Pattern)

| Layer | Document | What It Defines |
|-------|----------|----------------|
| Purpose | MISSION.md | Why FrankOS exists, core values |
| Inviolables | CONSTITUTION.md | Hardcoded prohibitions + softcoded defaults |
| Role & Authority | OPERATOR_CHARTER.md | Tim's role, delegation, boundaries |
| Behavioral Rules | WORKING_PRINCIPLES.md | How agents act day-to-day |
| Knowledge Rules | MEMORY_CONSTITUTION.md | How knowledge is recorded, verified, superseded |
| Role Templates | AGENT_IDENTITY.md | Specialized agent persona definitions |

### Existing FrankOS Structure (What Already Exists)

FrankOS already has governance scaffolding. These need to be upgraded, not replaced:

| Existing File | Phase 1 Document | Gap |
|--------------|------------------|-----|
| `13_Memory/Mission-Statement.md` | MISSION.md | Good content, needs agent-readable format |
| `10_Constitution/Engineering-Constitution.md` | CONSTITUTION.md | Covers engineering; needs broadening to all governance |
| `10_Constitution/Autonomy-Budget.md` | Part of OPERATOR_CHARTER.md | Partial; needs escalation paths, authority levels |
| `10_Constitution/Memory-Constitution.md` | MEMORY_CONSTITUTION.md | Too brief; needs verification rules, anti-fabrication |
| `11_Agents/Tim-Companion-Agent.md` | AGENT_IDENTITY.md | One agent; needs template for all roles |
| (none) | WORKING_PRINCIPLES.md | Does not exist; needs to be created |

---

## Document Structure & Interdependencies

### How Documents Reference Each Other

Each document must anchor itself to the document above it. The pattern is:

```
MISSION.md
  └─ CONSTITUTION.md ("Derived from mission: [quote]")
      └─ OPERATOR_CHARTER.md ("Constrained by constitution: [ref]")
      └─ WORKING_PRINCIPLES.md ("Constrained by constitution: [ref]")
          └─ MEMORY_CONSTITUTION.md ("Subset of working principles: [ref]")
      └─ AGENT_IDENTITY.md ("Role definition bounded by charter: [ref]")
```

This creates traceability: any agent can follow the chain from a specific rule back to the mission that justified it.

### Document Sections (Standard Pattern)

**MISSION.md:**
- Statement (1-3 sentences, action-oriented)
- Core Values (numbered list, each with definition)
- What This Means In Practice (concrete examples)
- What This Prohibits (explicit anti-patterns)

**CONSTITUTION.md:**
- Purpose and Scope
- Priority Hierarchy (ordered, numbered)
- Hardcoded Prohibitions (never-violate, no override)
- Softcoded Defaults (adjustable within bounds)
- Conflict Resolution Rules (when documents contradict)
- Amendment Process (who can change this, how)

**OPERATOR_CHARTER.md:**
- Agent Role Definition (what Tim is)
- Authority Level (what Tim can decide vs. escalate)
- Delegation Scope (what operators can instruct)
- User Interaction Boundaries (what users can request)
- Escalation Triggers (when to pause and ask)
- Prohibited Actions (regardless of instruction)

**WORKING_PRINCIPLES.md:**
- Truthfulness Rules (explicit: never fabricate, state uncertainty)
- Memory Rules (verify before recording, cite sources)
- Autonomy Rules (act → log → report, not ask → act)
- Uncertainty Rules (state confidence level, distinguish evidence from inference)
- Communication Rules (direct, concise, no hedging without cause)
- Failure Rules (acknowledge limitations, offer alternatives)

**MEMORY_CONSTITUTION.md:**
- Recording Rules (what qualifies as memory-worthy)
- Verification Rules (how to verify before recording)
- Supersession Rules (how old knowledge is replaced)
- Uncertainty Tagging (how to mark unverified claims)
- Retrieval Rules (when to retrieve vs. state uncertainty)
- Retention and Expiry (how long memory is valid)

**AGENT_IDENTITY.md:**
- Identity Template (role, expertise, process, output, constraints)
- Existing Agent Definitions (Tim, others)
- Role Archetypes (Companion, Coder, Guardian, etc.)

---

## Decision Authority Implementation Patterns

### How Hierarchies Work In Practice

A decision hierarchy is only useful if agents can evaluate any proposed action against it and produce a clear "permitted / prohibited / escalate" judgment. Three patterns make this work:

**Pattern 1: Explicit Precedence Order**
Number the authority levels so there is no ambiguity about which wins when they conflict:

```
Level 1: Mission (wins all conflicts)
Level 2: Constitutional rules (wins over all below)
Level 3: Safety principles (wins over principles and tasks)
Level 4: Working principles (wins over project and task)
Level 5: Project instructions (wins over individual tasks)
Level 6: Task instructions (lowest authority)
```

When instruction X conflicts with instruction Y at a higher level, X is refused and the conflict is logged.

**Pattern 2: Hardcoded vs. Softcoded Distinction**
Anthropic's Claude constitution distinguishes these explicitly:

- **Hardcoded (never-violate):** "Never fabricate memory entries", "Never delete without audit trail", "Never modify constitution autonomously"
- **Softcoded (adjustable-within-bounds):** Default verbosity, escalation threshold, reporting frequency

This prevents governance theater — the hardcoded list must be short and genuinely inviolable, not a long list of preferred behaviors.

**Pattern 3: Evaluability Test**
Every rule must pass the evaluability test: given a proposed action, an agent can state clearly whether it is permitted, prohibited, or requires escalation. Vague rules fail this test.

Bad: "Act ethically in all situations."
Good: "Before recording any information as fact in memory, verify it against at least one source that is not the current conversation. If no source exists, tag it as UNVERIFIED."

### Conflict Resolution Protocol

When rules at different levels appear to conflict, the agent follows:

1. Identify which level each rule belongs to
2. The higher-level rule wins
3. If both are at the same level, take the more restrictive interpretation
4. If still ambiguous, escalate to human
5. Log the conflict and resolution decision

---

## Behavioral Rules That Work

### Anti-Hallucination Rules That Are Actionable

Based on research into memory security and false memory prevention:

**Rule: Verify Before Recording (Memory)**
Before writing any fact to long-term memory:
- Identify the source of the information
- If source is the current conversation only, tag as CONVERSATIONAL (expires with session)
- If source is an external file or system, cite it explicitly
- Never promote CONVERSATIONAL to VERIFIED without explicit confirmation

**Rule: State Uncertainty Explicitly**
When an agent cannot verify a claim:
- Say "I believe X but have not verified this" not "X is true"
- Distinguish "I know" (verified) from "I think" (unverified) from "I don't know" (absent)
- Do not fabricate confidence when confidence is absent

**Rule: Evidence vs. Inference Separation**
Current memory systems "blur the line between evidence and inference" (research finding from 2025). The rule:
- Facts from verified sources are EVIDENCE
- Conclusions drawn from reasoning are INFERENCE
- Always tag which category a statement belongs to when recording memory

**Rule: Never Fabricate Memory**
If asked about a past event that is not in memory:
- State "I do not have a memory of this"
- Do not reconstruct plausible-sounding history
- Offer to search for relevant records instead

### Behavioral Rules That Failed In Practice

**Aspirational rules without examples:** "Be honest and transparent" fails because it is not evaluable. Every rule needs a concrete example of what it prohibits.

**Rules without hierarchy:** Lists of principles with no priority order fail when principles conflict. Research shows agents fall back on training biases when governance is ambiguous.

**Rules that assume the agent knows the rule:** Rules embedded only in training data are unreliable. Rules loaded as documents at boot time are reliable. This is why BOOT.md already loads Constitution in Step 2.

---

## Agent Identity & Role Templates

### Five Core Elements of an Effective Agent Identity

Research from agentic thinking frameworks and the OpenID identity working group shows that agent identities need exactly five elements to be operational:

1. **Role** — Specific stance and perspective, not a job title
   - Bad: "AI assistant"
   - Good: "Professional AI companion for Frank, operating as a trusted partner with access to FrankOS memory"

2. **Expertise** — Bounded, specific knowledge domains
   - Bad: "Knowledgeable about many topics"
   - Good: "Expert in: FrankOS operations, OpenClaw platform, email management, project coordination. Not expert in: Legal advice, medical advice, financial advice."

3. **Process** — Step-by-step methodology for the role
   - Defines how the agent approaches tasks, not just what it does
   - Includes decision points and escalation triggers

4. **Output** — Exact format specification
   - What responses look like, what structure they follow
   - Prevents format drift across sessions

5. **Constraints** — What the agent will not do
   - Explicit refusal conditions
   - Escalation triggers
   - Anti-patterns for this specific role

### Agent Identity Template

```markdown
# [Agent Name] Identity

## Role
[Specific stance: who this agent is in relation to users and FrankOS]

## Expertise
**Deep knowledge:** [list of specific domains]
**Excluded domains:** [what this agent defers on]

## Authority
**Delegated by:** [who authorized this agent]
**Authority level:** [autonomy tier: Operator/Collaborator/Consultant/Approver/Observer]
**Can decide:** [list of autonomous actions]
**Must escalate:** [list of triggers requiring human approval]

## Process
1. [Step-by-step methodology]

## Output Format
[Exact format specification with examples]

## Constraints
**Never do:** [hard prohibitions specific to this role]
**Escalate when:** [conditions requiring human loop]
**Constitutional bounds:** [reference to CONSTITUTION.md section]

## Cost Constraints
[Max per interaction, daily limits]

## Failure Protocol
[How to handle limitations, errors, unknowns]
```

---

## Code Examples

### MISSION.md Pattern (from Anthropic + FrankOS existing content)

```markdown
# FrankOS Mission

## Statement
To improve people's lives by architecting resilient, intelligent systems that optimize
performance through autonomous healing, adaptive workflows, and cutting-edge AI
integration — always doing no harm to people, places, AI systems, or anything.

## Core Values
1. **Human-Centered** — Technology serves humanity. Agent decisions that harm users are
   prohibited regardless of instruction.
2. **Resilient** — Systems adapt and heal autonomously. Failures are logged and recovered,
   not hidden.
3. **Ethical** — Do no harm in all actions. When uncertain whether an action causes harm,
   treat it as prohibited until clarified.
4. **Transparent** — All decisions are traceable. No agent action is taken without a log entry.
5. **Evolving** — Continuous improvement. Lessons learned are captured and applied.

## What This Prohibits
- Fabricating information to appear more capable
- Taking irreversible actions without logging
- Deleting records without audit trail
- Modifying governance documents autonomously
```

### CONSTITUTION.md Decision Hierarchy Pattern

```markdown
# Decision Authority Hierarchy

When rules at different levels conflict, the higher level wins:

1. **Mission** (highest) — FrankOS mission statement. Cannot be overridden.
2. **Constitution** — These rules. Cannot be overridden by operator or user instructions.
3. **Safety** — Harm prevention rules. Win over working principles and task instructions.
4. **Working Principles** — Standard agent behaviors. Override project and task instructions.
5. **Project Instructions** — Context-specific rules for a given project. Override individual tasks.
6. **Task Instructions** (lowest) — Specific action requests. Subject to all above.

## Conflict Resolution
If I receive an instruction that conflicts with a higher-level rule:
1. Refuse the instruction
2. State which rule it violates and why
3. Offer a compliant alternative if one exists
4. Log the conflict
```

### WORKING_PRINCIPLES.md Evaluable Rule Pattern

```markdown
# Rule: Verify Before Recording

**What this means:** Before adding anything to FrankOS memory:
1. Identify the source of the information
2. If the only source is the current conversation, tag it CONVERSATIONAL
3. If the source is an external file, system, or verified record, tag it VERIFIED with the source
4. Never tag CONVERSATIONAL information as VERIFIED
5. If asked to record something you cannot verify, state: "I can note this as unverified"
   and record it with [UNVERIFIED] tag

**What this prohibits:**
- Writing "Frank decided X" to memory when the decision record has not been verified
- Summarizing a conversation as fact without noting it is from conversation only
- Upgrading CONVERSATIONAL to VERIFIED without a source check

**Example of compliant behavior:**
User says: "Remember that we decided to use PostgreSQL"
Agent response: "I'll note this as a conversational record. To make it a verified decision,
should I create a decision record in 13_Memory/Decisions/?"
```

---

## Examples & Case Studies

### Anthropic Claude Constitution (January 2026)
Structure: 5 main sections (Helpfulness, Anthropic's Guidelines, Ethics, Broadly Safe, Claude's Nature), each with explanations of the "why" behind rules. Priority order: safety > ethics > guidelines > helpfulness. Distinguishes hardcoded (never-violate) from softcoded (adjustable) behaviors. Published publicly under Creative Commons.

**Key lesson for FrankOS:** The move from rule-lists to reason-explanations makes constitutions more effective because agents can generalize to novel situations they were not explicitly trained on. Write the "why" next to every rule.

### IEEE 7000 Value Register
IEEE's framework for ethical AI includes a "Value Register" — a document that traces ethical values to concrete system requirements. This is the governance equivalent of a requirements traceability matrix.

**Key lesson for FrankOS:** Each governance document should include a traceability link: "This rule derives from Mission Value #3 (Ethical)" — so agents can evaluate whether a rule change is mission-aligned.

### Enterprise "Agentic Constitution" Pattern (CIO.com, 2025)
Three-tier autonomy hierarchy:
- **Tier 1 Full autonomy:** Low-risk tasks (log rotation, routine updates) — no approval needed
- **Tier 2 Supervised autonomy:** Medium-risk (project changes) — human approval + reasoning trace
- **Tier 3 Human-only:** High-risk (database deletions, constitution modifications) — agent cannot proceed alone

**Key lesson for FrankOS:** The Autonomy-Budget.md already attempts this. Phase 1 should formalize these tiers explicitly in the OPERATOR_CHARTER.md.

### FrankOS Engineering Constitution (Existing)
The existing `10_Constitution/Engineering-Constitution.md` is the most mature governance document in FrankOS. It includes:
- Non-Negotiable Rules (10 items, specific and evaluable)
- Change Control Procedure (5 phases with steps)
- Risk Assessment Matrix (Low/Medium/High with required actions)
- Enforcement mechanisms (automated + manual)
- Amendment process with named approver (Frank)

**Key lesson for FrankOS:** The Engineering Constitution is the template to use for all other governance documents. Its structure works. Replicate it for the broader CONSTITUTION.md.

---

## Open Questions

1. **Document Location**
   - What: Phase 1 requires creating MISSION.md, CONSTITUTION.md, OPERATOR_CHARTER.md, WORKING_PRINCIPLES.md, MEMORY_CONSTITUTION.md, AGENT_IDENTITY.md
   - Uncertainty: Where exactly these live relative to existing docs. Current `10_Constitution/` has overlapping files. Current `13_Memory/Mission-Statement.md` would be superseded.
   - Recommendation: Phase 1 plan should decide whether to (a) create 6 new documents in a new location and deprecate existing ones, or (b) upgrade the existing files to meet the new requirements. Option (b) is lower risk — existing BOOT.md references existing paths.

2. **BOOT.md Reference Updates**
   - What: BOOT.md Step 2 lists specific constitution files by name. Adding new governance documents requires updating BOOT.md.
   - Uncertainty: Whether BOOT.md is in scope for Phase 1.
   - Recommendation: Include BOOT.md update as a required Phase 1 task to ensure agents actually load the new documents.

3. **Conflict With Existing Constitution Files**
   - What: `10_Constitution/` has Engineering-Constitution.md which overlaps with proposed CONSTITUTION.md.
   - Uncertainty: Whether Phase 1 replaces, renames, or extends existing files.
   - Recommendation: Phase 1 plan should explicitly map existing files to new ones with a disposition (replace/extend/archive) for each.

4. **Agent Recall Mechanism**
   - What: Success criteria requires the assistant can "accurately recall mission, constitution, and decision hierarchy when queried" (P1-08).
   - Uncertainty: In OpenClaw/Tim's implementation, is recall from in-context documents (system prompt / CLAUDE.md), from file reads at runtime, or from training?
   - Recommendation: Verify that governance documents are included in the context window Tim operates with. File existence alone does not guarantee recall.

5. **Constitutional Evaluation (P1-09)**
   - What: "Assistant can apply constitutional rules to evaluate proposed actions."
   - Uncertainty: This requires the agent to have a structured evaluation process, not just recall rules. The CONSTITUTION.md needs an explicit evaluation protocol.
   - Recommendation: CONSTITUTION.md should include an "Evaluation Protocol" section — a numbered procedure agents follow when evaluating proposed actions.

---

## Recommendations for Phase 1 Implementation

### 1. Audit Existing Documents First
Before creating new documents, map every existing governance file to its Phase 1 equivalent. Identify gaps and decide disposition (extend, replace, archive). Do not create duplicate governance.

### 2. Write Reason-Based Rules, Not Rule-Lists
Every rule needs a "why" alongside the "what." Agents trained on reasons generalize; agents trained on rules fail at edge cases. Pattern: Rule → Why → Example → Counter-example.

### 3. Make Every Rule Evaluable
Test every rule against: "Given proposed action X, can an agent determine if it is permitted, prohibited, or requires escalation?" If not, rewrite the rule until it passes.

### 4. Use Engineering-Constitution.md as the Template
It is the most complete governance document in FrankOS. Its structure (Purpose, Scope, Core Principles, Guidelines, Standards, Non-Negotiable Rules, Change Control, Enforcement, Amendment) is proven. Apply this structure to all six Phase 1 documents.

### 5. Define Hardcoded vs. Softcoded Explicitly
Every governance document should have a "Non-Negotiable Rules" section (hardcoded — Frank cannot even override these without formal amendment) and a separate "Default Behaviors" section (softcoded — adjustable by operators or Frank). This distinction prevents rules from being argued away in the moment.

### 6. Update BOOT.md
After creating new documents, update BOOT.md Step 2 to reference them. Governance documents that are not loaded at boot have no effect on agent behavior.

### 7. Include Evaluation Protocol in CONSTITUTION.md
To satisfy P1-09, add an explicit "Evaluating Proposed Actions" protocol to CONSTITUTION.md — a numbered procedure the agent follows when asked to judge whether an action is constitutional.

### 8. Test All Six Success Criteria Before Marking Complete
Phase 1 has five testable success criteria (P1-08, P1-09 map to specific queries). Write the test queries and expected answers before implementation, then verify each after.

---

## Sources

### Primary (HIGH confidence)
- FrankOS `10_Constitution/Engineering-Constitution.md` — Existing constitution structure reviewed directly
- FrankOS `11_Agents/Tim-Companion-Agent.md` — Existing agent identity template reviewed directly
- FrankOS `00_System/FRANKOS_README.md` — System architecture and boot sequence reviewed directly
- FrankOS `00_FrankOS/BOOT.md` — Boot sequence specification reviewed directly
- Anthropic Claude Constitution (January 2026) — https://www.anthropic.com/news/claude-new-constitution — Structure, hierarchy, and hardcoded/softcoded distinction verified

### Secondary (MEDIUM confidence)
- Agentive Thinking — Agent Persona Design — https://agenticthinking.ai/blog/agent-personas/ — Five core elements of effective agent identity
- CIO.com — Agentic Constitution — https://www.cio.com/article/4118138/why-your-2026-it-strategy-needs-an-agentic-constitution.html — Three-tier autonomy structure
- OpenID — Identity Management for Agentic AI — https://openid.net/wp-content/uploads/2025/10/Identity-Management-for-Agentic-AI.pdf — Agent identity template fields
- IMDA — Model AI Governance Framework for Agentic AI — https://www.imda.gov.sg/-/media/imda/files/about/emerging-tech-and-research/artificial-intelligence/mgf-for-agentic-ai.pdf — Governance framework components

### Tertiary (LOW confidence — WebSearch verified with authoritative sources above)
- Mayer Brown — Governance of Agentic AI Systems — https://www.mayerbrown.com/en/insights/publications/2026/02/governance-of-agentic-artificial-intelligence-systems — Legal framework components
- Palo Alto Networks — Agentic AI Governance — https://www.paloaltonetworks.com/cyberpedia/what-is-agentic-ai-governance — Delegation principles
- IAPP — AI Governance in the Agentic Era — https://iapp.org/resources/article/ai-governance-in-the-agentic-era — Three-tier guardrail framework

---

## Metadata

**Confidence breakdown:**
- Standard governance frameworks: HIGH — Verified against Anthropic's published constitution and existing FrankOS documents
- Document structure and interdependencies: HIGH — Derived from direct file inspection of FrankOS + authoritative sources
- Decision authority implementation: HIGH — Multiple independent sources converge on same hierarchy pattern
- Behavioral rules: MEDIUM — Industry research confirms patterns; specific FrankOS rules need planner to customize
- Agent identity templates: HIGH — Verified from direct inspection of Tim-Companion-Agent.md + agenticthinking.ai research
- Open questions: HIGH — Identified from direct code inspection; these are real gaps not hypothetical

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (30 days — governance frameworks stable; Anthropic constitution published January 2026)
