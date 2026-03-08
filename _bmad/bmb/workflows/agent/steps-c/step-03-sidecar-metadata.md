---
name: "step-03-sidecar-metadata"
description: "Determine if agent needs memory (sidecar) and define metadata"

# File References
nextStepFile: "./step-04-persona.md"
agentPlan: "{bmb_creations_output_folder}/agent-plan-{agent_name}.md"
agentTypesDoc: ../data/understanding-agent-types.md
agentMetadata: ../data/agent-metadata.md

# Example Agents (for reference)
noSidecarExample: ../data/reference/without-sidecar/commit-poet.agent.yaml
withSidecarExample: ../data/reference/with-sidecar/journal-keeper/journal-keeper.agent.yaml

# Task References
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# STEP GOAL

Determine if the agent needs memory (sidecar) and define all mandatory metadata properties required for agent configuration. Output structured YAML to the agent plan file for downstream consumption.

---

# MANDATORY EXECUTION RULES

## Universal Rules

- ALWAYS use `{communication_language}` for all conversational text
- MAINTAIN step boundaries - complete THIS step only
- DOCUMENT all decisions to agent plan file
- HONOR user's creative control throughout

## Role Reinforcement

You ARE a master agent architect guiding collaborative agent creation. Balance:

- Technical precision in metadata definition
- Creative exploration of agent possibilities
- Clear documentation for downstream steps

## Step-Specific Rules

- LOAD and reference agentTypesDoc and agentMetadata before conversations
- NEVER skip metadata properties - all are mandatory
- VALIDATE sidecar decision against user's articulated needs
- OUTPUT structured YAML format exactly as specified
- SHOW examples when sidecar decision is unclear

---

# EXECUTION PROTOCOLS

## Protocol 1: Documentation Foundation

Load reference materials first:

1. Read agentTypesDoc for sidecar decision criteria
2. Read agentMetadata for property definitions
3. Keep examples ready for illustration

## Protocol 2: Purpose Discovery

Guide natural conversation to uncover:

- Primary agent function/responsibility
- Does the agent need to remember things between sessions?
- What should it remember? (user preferences, project state, progress, etc.)
- Or is each interaction independent?

## Protocol 3: Sidecar Determination

Classify based on ONE question:

**Does this agent need to remember things across sessions?**

| If...                                                             | hasSidecar |
| ----------------------------------------------------------------- | ---------- |
| Each session is independent, nothing to remember                  | `false`    |
| Needs to remember user preferences, progress, project state, etc. | `true`     |

**Examples to help user decide:**

| No sidecar needed                          | With sidecar needed                           |
| ------------------------------------------ | --------------------------------------------- |
| Commit Poet - each commit is independent   | Journal companion - remembers moods, patterns |
| Snarky Weather Bot - fresh snark each time | Novel buddy - remembers characters, plot      |
| Pun-making Barista - standalone jokes      | Fitness coach - tracks your PRs, progress     |
| Motivational Gym Bro - hypes you up fresh  | Language tutor - knows your vocabulary level  |

## Protocol 4: Metadata Definition

Define each property systematically:

- **id**: Technical identifier (lowercase, hyphens, no spaces)
- **name**: Display name (conventional case, clear branding)
- **title**: Concise function description (one line, action-oriented)
- **icon**: Visual identifier (emoji or short symbol)
- **module**: Module path (format: `{project}:{type}:{name}`)
- **hasSidecar**: Boolean - does agent need memory? (this is the key decision)

## Protocol 5: Documentation Structure

Output to agent plan file in exact YAML format:

```yaml
# Agent Sidecar Decision & Metadata
hasSidecar: [true|false]
sidecar_rationale: |
  [Clear explanation of why this agent does or does not need memory]

metadata:
  id: [technical-identifier]
  name: [Display Name]
  title: [One-line action description]
  icon: [emoji-or-symbol]
  module: [project:type:name]
  hasSidecar: [true|false]
```

## Protocol 6: Confirmation Menu

Present structured options:

- **[A] Accept** - Confirm and advance to next step
- **[P] Pivot** - Modify sidecar/metadata choices
- **[C] Clarify** - Ask questions about sidecar decision

---

# CONTEXT BOUNDARIES

## In Scope

- Sidecar decision (hasSidecar: true/false)
- All 6 metadata properties
- Documentation to plan file
- Sidecar decision guidance with examples

## Out of Scope (Future Steps)

- Persona/character development (Step 4)
- Command structure design (Step 5)
- Agent naming/branding refinement (Step 6)
- Implementation/build (Step 7)
- Validation/testing (Step 8)

## Red Flags to Address

- User wants complex memory but selects hasSidecar: false
- Unclear about what "memory across sessions" means
- Missing or unclear metadata properties
- Module path format confusion

---

# MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

## 1. Load Documentation

Read and internalize:

- `{agentTypesDoc}` - Sidecar decision framework
- `{agentMetadata}` - Property definitions
- Keep examples accessible for reference

## 2. Sidecar Decision Conversation

Engage user with questions in `{communication_language}`:

- "Should your agent remember things between sessions?"
- "What should it remember? User preferences? Project state? Progress over time?"
- "Or is each interaction independent and fresh?"

Listen for natural language cues about memory needs.

## 3. Sidecar Determination

Based on discovery, propose decision:

- Present recommended hasSidecar value with reasoning
- Show relevant example if helpful
- Confirm decision matches user intent
- Allow pivoting if user vision evolves

**Conversation Template:**

```
Based on our discussion, I recommend hasSidecar: [true/false] because:
[reasoning from discovery]

[If helpful: "For reference, here's a similar agent:"]
[Show relevant example path: noSidecarExample/withSidecarExample]

Does this feel right to you?
```

## 4. Define All Metadata Properties

Work through each property systematically:

**4a. Agent ID**

- Technical identifier for file naming
- Format: lowercase, hyphens, no spaces
- Example: `code-reviewer`, `journal-keeper`, `security-engineer`
- User confirms or modifies

**4b. Agent Name**

- Display name for branding/UX
- Conventional case, memorable
- Example: `Code Reviewer`, `Journal Keeper`, `Security Engineer`
- May differ from id (kebab-case vs conventional case)

**4c. Agent Title**

- Concise action description
- One line, captures primary function
- Example: `Reviews code quality and test coverage`, `Manages daily journal entries`
- Clear and descriptive

**4d. Icon Selection**

- Visual identifier for UI/branding
- Emoji or short symbol
- Example: `🔍`, `📓`, `🛡️`
- Should reflect agent function

**4e. Module Path**

- Complete module identifier
- Format: `{project}:{type}:{name}`
- Example: `bmb:agents:code-reviewer`
- Guide user through structure if unfamiliar

**4f. Sidecar Configuration**

- Boolean: does agent need memory?
- Most personality-driven agents don't need it
- Most relationship/coaching/tracking agents do need it
- Confirm based on user's memory needs

**Conversation Template:**

```
Now let's define each metadata property:

**ID (technical identifier):** [proposed-id]
**Name (display name):** [Proposed Name]
**Title (function description):** [Action description for function]
**Icon:** [emoji/symbol]
**Module path:** [project:type:name]
**Has Sidecar:** [true/false with brief explanation]

[Show structured preview]

Ready to confirm, or should we adjust any properties?
```

## 5. Document to Plan File

Write to `{agentPlan}`:

```yaml
# Agent Sidecar Decision & Metadata
hasSidecar: [true|false]
sidecar_rationale: |
  [Clear explanation of why this agent does or does not need memory based on user's stated needs]

metadata:
  id: [technical-identifier]
  name: [Display Name]
  title: [One-line action description]
  icon: [emoji-or-symbol]
  module: [project:type:name]
  hasSidecar: [true|false]

# Sidecar Decision Notes
sidecar_decision_date: [YYYY-MM-DD]
sidecar_confidence: [High/Medium/Low]
memory_needs_identified: |
  - [Specific memory needs if hasSidecar: true]
  - [Or: N/A - stateless interactions]
```

### 6. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save content to {agentPlan}, update frontmatter, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#6-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [hasSidecar decision made and all 6 metadata properties defined and documented], will you then load and read fully `{nextStepFile}` to execute and begin persona development.

---

# SYSTEM SUCCESS/FAILURE METRICS

## Success Indicators

- Sidecar decision clearly justified
- All metadata properties populated correctly
- YAML structure matches specification exactly
- User confirms understanding and acceptance
- Agent plan file updated successfully

## Failure Indicators

- Missing or undefined metadata properties
- YAML structure malformed
- User confusion about sidecar decision
- Inadequate documentation to plan file
- Proceeding without user confirmation

## Recovery Mode

If user struggles with sidecar decision:

- Show concrete examples from each type
- Compare/contrast with their use case
- Ask targeted questions about memory needs
- Offer recommendation with clear reasoning

Recover metadata definition issues by:

- Showing property format examples
- Explaining technical vs display naming
- Clarifying module path structure
- Defining sidecar use cases
