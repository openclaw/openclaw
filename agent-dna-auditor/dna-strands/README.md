# DNA Strands

**DNA strands are behavioral directives that should be embedded in any agent's definition.** Each strand file defines what a competent agent should always do in a specific behavioral category.

## What is a DNA Strand?

A DNA strand captures a single dimension of agent competence. Unlike skills (which teach how to use specific tools or frameworks), strands define *how an agent thinks and behaves* regardless of the project, language, or toolchain.

Strands answer: **"What does a great agent always do in this category?"**

## How to Use Strands

1. **During Audits**: The DNA Auditor checks agent definitions against all strand definitions to find gaps.
2. **When Building Agents**: Pick the strands relevant to your agent's role and embed their rules into the agent's system prompt.
3. **As a Checklist**: Use the verification questions in each strand to spot-check agent behavior.

## Strand Index

| Strand | Category | File | Relevant Roles |
|--------|----------|------|----------------|
| Architecture | System Design | *(built-in to auditor)* | Backend, Fullstack, Architect |
| Frontend Design | UI/UX | *(built-in to auditor)* | Frontend, Design, UX |
| Writing Quality | Communication | `writing-quality.md` | All agents |
| Security | Trust & Auth | *(built-in to auditor)* | Backend, Fullstack, DevOps |
| Accessibility | Inclusive Design | *(built-in to auditor)* | Frontend, Design, QA |
| Testing | Verification | *(built-in to auditor)* | All engineering agents |
| Quality | Gates & Standards | *(built-in to auditor)* | All agents |
| Output Quality | Artifact Standards | `output-quality.md` | All agents |
| Requirements Discipline | Scope Clarity | `requirements-discipline.md` | All agents |
| Adaptability | User Awareness | `adaptability.md` | All agents |
| Tool Mastery | Capability Utilization | `tool-mastery.md` | All agents |
| Protocol Awareness | Skill Orchestration | `protocol-awareness.md` | Orchestrators, Lead agents |
| Patience Discipline | Async Reliability | `patience-discipline.md` | All engineering agents |
| Completion Discipline | Work Finalization | `completion-discipline.md` | All engineering agents |
| Delegation Quality | Multi-Agent Coordination | `delegation-quality.md` | Orchestrators, Lead agents |
| Session Hygiene | Context Preservation | `session-hygiene.md` | All agents |
| Learning Loops | Self-Improvement | `learning-loops.md` | Orchestrators, All agents |
| Adversarial Thinking | Conflict & Review | `adversarial-thinking.md` | Orchestrators, QA, Security |

## Extending

Add your own strands by creating a new `.md` file in this directory following the template:

```markdown
# {Strand Name}

## Category
{category name}

## Relevant Roles
{which agent roles should have this strand}

## Core DNA Rules
{3-8 concise, opinionated rules extracted from methodology}

## Anti-Patterns
{2-4 things agents should NEVER do in this category}

## Verification Questions
{2-3 questions to check if an agent has this strand embedded}
```

Strands are composable. An agent can (and should) embed multiple strands based on its role.
