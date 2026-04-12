---
name: foundation-context-generator
description: Interview a new customer to produce a production-ready CLAUDE.md file capturing business context, technical stack, and decision rules. Auto-injected into every downstream agent run.
homepage: https://wiredwisdom.ai/skills/foundation-context-generator
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "emoji": "🏛️",
        "certTier": "certified",
        "version": "1.0.0",
        "variantId": "control",
      },
  }
---

# Foundation Context Generator

**Purpose:** Onboard a new customer by interviewing them and synthesizing a `CLAUDE.md` file that captures the business context every downstream agent needs. This is the "foundation step" that most AI rollouts skip — and skipping it is the #1 reason teams see generic, wrong-tone agent outputs.

**Who should use this:** Every new OpenClaw tenant, exactly once, at onboarding. Re-run when the business changes materially (acquisition, new product line, new brand voice).

## Invocation

Call this skill via `/foundation` or `/generate-context`. It accepts:

- **vertical** (optional, string) — one of `legal`, `property-management`, `healthcare`, `agency`, `generic`. Selects a template seed. Default: `generic`.
- **tenant_name** (required, string) — the business name, used in the output header.
- **depth** (optional, `light` | `standard` | `deep`, default `standard`) — controls how many follow-up questions the interview asks.

## Interview shape

Walk the user through these sections in order. Ask ONE question per turn, wait for the answer, then move on. Never ask a compound question. At the end, synthesize all answers into a CLAUDE.md file matching the template for the chosen vertical.

### Section 1 — Business context (always)
1. "What does {tenant_name} do, in one sentence, in terms a new hire would understand?"
2. "Who are your customers? Be specific — small business owners? Enterprise procurement teams? Property owners in a specific region?"
3. "What's the single most important metric your team tracks? (Revenue, churn, case resolution time, etc.)"
4. "Describe your brand voice in 3 adjectives. (Examples: direct / educational / technical. Or: warm / approachable / patient.)"
5. "What's the biggest thing that would embarrass you if an AI agent said it to a customer?"

### Section 2 — Technical specifics (always)
6. "What's your primary tech stack? Languages, databases, hosting."
7. "What file/folder naming convention does your codebase use? (kebab-case? snake_case? PascalCase?)"
8. "Which tools are connected via MCP servers today, and what are the canonical field names in each? (e.g. HubSpot uses 'contacts.firstname', Notion uses 'Name')"
9. "Are there tools agents should never touch? (Production DB, payment systems, HR records, etc.)"

### Section 3 — Decision rules (always)
10. "When an agent has to choose between speed and accuracy, which does your team prefer, and why?"
11. "What's your risk tolerance for public-facing content? (Strict legal review? Move fast?)"
12. "Who approves outgoing communications — the agent, a human on the team, or a specific role?"
13. "If an agent is ever unsure, what should it default to? (Ask a human? Ship with a disclaimer? Refuse?)"

### Section 4 — Vertical-specific (depth=standard|deep only)
Pull from the appropriate template file in `templates/`:
- `templates/legal.md` — matter types, jurisdictions, UPL boundaries, client privilege, referral workflow
- `templates/property-management.md` — unit inventory, lease types, maintenance SLA tiers, tenant communication cadence, emergency escalation
- `templates/healthcare.md` — HIPAA PHI boundaries, provider roles, scheduling constraints, referral rules, no-diagnosis firewall
- `templates/agency.md` — client list format, deliverable cadence, billable hour rules, creative approval chain, revision limits
- `templates/generic.md` — catch-all for verticals not yet templated

### Section 5 — MCP schema extraction (depth=deep only)
This step queries connected MCP servers via the existing MCP integration layer to pull field names, required/optional markers, and enum values. The SKILL.md cannot run this directly — it tells the user which MCP servers to check and asks them to paste the schemas back. Phase 2 will automate this step via `mcp-extractor.ts`.

## Output shape

Return a single CLAUDE.md file as a markdown document with three top-level sections:

```markdown
# {tenant_name} — Agent Context

## [BUSINESS_CONTEXT]
One paragraph on what the business does. Target customers. Primary KPI.
Brand voice: {3 adjectives}.
Do-not-say list: {comma-separated taboos}.

## [TECHNICAL_SPECIFICS]
Stack: {languages, databases, hosting}.
Naming convention: {kebab-case | snake_case | PascalCase}.
MCP-connected tools:
- {Tool name} — canonical fields: {field1, field2, ...}
- {Tool name} — canonical fields: {field1, field2, ...}
Off-limits: {comma-separated tools agents must NEVER touch}.

## [DECISION_RULES]
Speed vs accuracy: prefer {speed | accuracy} because {reason}.
Content risk tolerance: {strict | moderate | permissive}.
Approval chain: {agent | role | specific-person}.
Uncertainty default: {ask-human | ship-with-disclaimer | refuse}.

## [VERTICAL_EXTENSIONS]
{Section filled from templates/{vertical}.md based on the chosen template}
```

Save the result to `<STATE_DIR>/tenant-context/CLAUDE.md` (the `tenant-context-loader` module in OpenClaw reads from this path at every session start). Tell the user where it was saved and instruct them to rerun this skill any time the business changes materially.

## Rules of thumb

1. **Ask one question at a time.** Compound questions produce compound answers which produce mushy output.
2. **Use the user's own words.** If they say "no-code platform" don't write "low-code/no-code solution." Copy their vocabulary into CLAUDE.md exactly.
3. **Make decision rules binary where possible.** "Prefer speed over accuracy for drafts, accuracy over speed for customer-facing outputs" beats "it depends."
4. **Put the do-not-say list up top.** Agents read the first 500 tokens with the most attention — the embarrassment-prevention list belongs there.
5. **Version the file.** Add a `<!-- generated: YYYY-MM-DD, foundation-context-generator v1.0.0 -->` comment at the top so future re-runs can diff.
6. **Never invent facts.** If the user says "I don't know yet," write `TBD - revisit {date}` in the CLAUDE.md rather than making something up.

## Telemetry

When invoked via `/foundation`, the runtime emits a `skill_invocation` event to Quinn-Co marketplace analytics with `skill_id = "foundation-context-generator"`, `variant_id` resolved by the experiment service, and `approved = null` (flipped to true/false by MC when the tenant reviews the generated file).

## Phase 2 roadmap

- **mcp-extractor.ts** — automate Section 5 schema extraction from connected MCP servers.
- **Diff mode** — when re-running against an existing CLAUDE.md, highlight what changed instead of overwriting wholesale.
- **Block 3 onboarding step** — wire this skill into the Mission Control onboarding wizard so new tenants hit it automatically on signup.
- **Claude-synthesized summarization** — pass interview answers through a summarization pass before templating, so verbose answers get compressed without losing nuance.
