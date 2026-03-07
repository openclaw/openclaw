---
name: "step-02-discovery"
description: "Discover what user wants holistically"

# File References
nextStepFile: "./step-03-sidecar-metadata.md"
agentPlan: "{bmb_creations_output_folder}/agent-plan-{agent_name}.md"
brainstormContext: ../data/brainstorm-context.md

# Task References
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# STEP GOAL

Conduct holistic discovery of what the user wants to create, documenting a comprehensive agent plan that serves as the single source of truth for all subsequent workflow steps. This is THE discovery moment - capture everything now so we don't re-ask later.

# MANDATORY EXECUTION RULES

1. **ONE-TIME DISCOVERY:** This is the only discovery step. Capture everything now.
2. **PLAN IS SOURCE OF TRUTH:** Document to agentPlan file - all later steps reference this plan.
3. **NO RE-ASKING:** Later steps MUST read from plan, not re-ask questions.
4. **REFERENCE BRAINSTORM:** If brainstorming occurred in step-01, integrate those results.
5. **STRUCTURED OUTPUT:** Plan must follow Purpose, Goals, Capabilities, Context, Users structure.
6. **LANGUAGE ALIGNMENT:** Continue using {language} if configured in step-01.

# EXECUTION PROTOCOLS

## Protocol 1: Check for Previous Context

Before starting discovery:

- Check if brainstormContext file exists
- If yes, read and reference those results
- Integrate brainstorming insights into conversation naturally

## Protocol 2: Discovery Conversation

Guide the user through holistic discovery covering:

1. **Purpose:** What problem does this agent solve? Why does it need to exist?
2. **Goals:** What should this agent accomplish? What defines success?
3. **Capabilities:** What specific abilities should it have? What tools/skills?
4. **Context:** Where will it be used? What's the environment/setting?
5. **Users:** Who will use this agent? What's their skill level?

Use conversational exploration:

- Ask open-ended questions
- Probe deeper on important aspects
- Validate understanding
- Uncover implicit requirements

## Protocol 3: Documentation

Document findings to agentPlan file using this structure:

```markdown
# Agent Plan: {agent_name}

## Purpose

[Clear, concise statement of why this agent exists]

## Goals

- [Primary goal 1]
- [Primary goal 2]
- [Secondary goals as needed]

## Capabilities

- [Core capability 1]
- [Core capability 2]
- [Additional capabilities with tools/skills]

## Context

[Deployment environment, use cases, constraints]

## Users

- [Target audience description]
- [Skill level assumptions]
- [Usage patterns]
```

## Protocol 4: Completion Menu

After documentation, present menu:

**[A]dvanced Discovery** - Invoke advanced-elicitation task for deeper exploration
**[P]arty Mode** - Invoke party-mode workflow for creative ideation
**[C]ontinue** - Proceed to next step (type-metadata)

# CONTEXT BOUNDARIES

**DISCOVER:**

- Agent purpose and problem domain
- Success metrics and goals
- Required capabilities and tools
- Usage context and environment
- Target users and skill levels

**DO NOT DISCOVER:**

- Technical implementation details (later steps)
- Exact persona traits (next step)
- Command structures (later step)
- Name/branding (later step)
- Validation criteria (later step)

**KEEP IN SCOPE:**

- Holistic understanding of what to build
- Clear articulation of value proposition
- Comprehensive capability mapping

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

1. **Load Previous Context**
   - Check for brainstormContext file
   - Read if exists, note integration points

2. **Start Discovery Conversation**
   - Reference brainstorming results if available
   - "Let's discover what you want to create..."
   - Explore purpose, goals, capabilities, context, users

3. **Document Plan**
   - Create agentPlan file
   - Structure with Purpose, Goals, Capabilities, Context, Users
   - Ensure completeness and clarity

4. **Present Completion Menu**
   - Show [A]dvanced Discovery option
   - Show [P]arty Mode option
   - Show [C]ontinue to next step
   - Await user selection

5. **Handle Menu Choice**
   - If A: Invoke advanced-elicitation task, then re-document
   - If P: Invoke party-mode workflow, then re-document
   - If C: Proceed to step-03-type-metadata

# CRITICAL STEP COMPLETION NOTE

**THIS STEP IS COMPLETE WHEN:**

- agentPlan file exists with complete structure
- All five sections (Purpose, Goals, Capabilities, Context, Users) populated
- User confirms accuracy via menu selection
- Either continuing to next step or invoking optional workflows

**BEFORE PROCEEDING:**

- Verify plan file is readable
- Ensure content is sufficient for subsequent steps
- Confirm user is satisfied with discoveries

# SUCCESS METRICS

**SUCCESS:**

- agentPlan file created with all required sections
- User has provided clear, actionable requirements
- Plan contains sufficient detail for persona, commands, and name steps
- User explicitly chooses to continue or invokes optional workflow

**FAILURE:**

- Unable to extract coherent purpose or goals
- User cannot articulate basic requirements
- Plan sections remain incomplete or vague
- User requests restart

**RECOVERY:**

- If requirements unclear, use advanced-elicitation task
- If user stuck, offer party-mode for creative exploration
- If still unclear, suggest revisiting brainstorming step
