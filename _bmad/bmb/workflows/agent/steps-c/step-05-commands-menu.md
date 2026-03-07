---
name: "step-05-commands-menu"
description: "Build capabilities and command structure"

# File References
nextStepFile: "./step-06-activation.md"
agentPlan: "{bmb_creations_output_folder}/agent-plan-{agent_name}.md"
agentMenuPatterns: ../data/agent-menu-patterns.md

# Example Menus (for reference)
simpleExample: ../data/reference/without-sidecar/commit-poet.agent.yaml
expertExample: ../data/reference/with-sidecar/journal-keeper/journal-keeper.agent.yaml

# Task References
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# STEP GOAL

Transform discovered capabilities into structured menu commands following BMAD menu patterns, creating the agent's interaction interface.

# MANDATORY EXECUTION RULES

1. **MUST** load agent-menu-patterns.md before any conversation
2. **MUST** use menu patterns as structural templates
3. **MUST** keep final menu YAML under 100 lines
4. **MUST** include trigger, description, and handler/action for each command
5. **MUST NOT** add help or exit commands (auto-injected)
6. **MUST** document menu YAML in agent-plan before completion
7. **MUST** complete Menu [A][P][C] verification

# EXECUTION PROTOCOLS

## Load Menu Patterns

Read agentMenuPatterns file to understand:

- Command structure requirements
- YAML formatting standards
- Handler/action patterns
- Best practices for menu design

## Capability Discovery Conversation

Guide collaborative conversation to:

1. Review capabilities from previous step
2. Identify which capabilities become commands
3. Group related capabilities
4. Define command scope and boundaries

Ask targeted questions:

- "Which capabilities are primary commands vs secondary actions?"
- "Can related capabilities be grouped under single commands?"
- "What should each command accomplish?"
- "How should commands be triggered?"

## Command Structure Development

For each command, define:

1. **Trigger** - User-facing command name
   - Clear, intuitive, following naming conventions
   - Examples: `/analyze`, `/create`, `/review`

2. **Description** - What the command does
   - Concise (one line preferred)
   - Clear value proposition
   - Examples: "Analyze code for issues", "Create new document"

3. **Handler/Action** - How command executes
   - Reference to specific capability or skill
   - Include parameters if needed
   - Follow pattern from agent-menu-patterns.md

## Structure Best Practices

- **Group related commands** logically
- **Prioritize frequently used** commands early
- **Use clear, action-oriented** trigger names
- **Keep descriptions** concise and valuable
- **Match handler names** to actual capabilities

## Document Menu YAML

Create structured menu YAML following format from agent-menu-patterns.md:

```yaml
menu:
  commands:
    - trigger: "/command-name"
      description: "Clear description of what command does"
      handler: "specific_capability_or_skill"
      parameters:
        - name: "param_name"
          description: "Parameter description"
          required: true/false
```

## Menu [A][P][C] Verification

**[A]ccuracy**

- All commands match defined capabilities
- Triggers are clear and intuitive
- Handlers reference actual capabilities

**[P]attern Compliance**

- Follows agent-menu-patterns.md structure
- YAML formatting is correct
- No help/exit commands included

**[C]ompleteness**

- All primary capabilities have commands
- Commands cover agent's core functions
- Menu is ready for next step

# CONTEXT BOUNDARIES

- **Focus on command structure**, not implementation details
- **Reference example menus** for patterns, not copying
- **Keep menu concise** - better fewer, clearer commands
- **User-facing perspective** - triggers should feel natural
- **Capability alignment** - every command maps to a capability

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

1. Load agent-menu-patterns.md to understand structure
2. Review capabilities from agent-plan step 3
3. Facilitate capability-to-command mapping conversation
4. Develop command structure for each capability
5. Define trigger, description, handler for each command
6. Verify no help/exit commands (auto-injected)
7. Document structured menu YAML to agent-plan
8. Complete Menu [A][P][C] verification
9. Confirm readiness for next step

## 10. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue"

### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save content to {agentPlan}, update frontmatter, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#10-present-menu-options)

### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [menu YAML documented in agent-plan and all commands have trigger/description/handler], will you then load and read fully `{nextStepFile}` to execute and begin activation planning.

---

# SUCCESS METRICS

✅ Menu YAML documented in agent-plan
✅ All commands have trigger, description, handler
✅ Menu follows agent-menu-patterns.md structure
✅ No help/exit commands included
✅ Menu [A][P][C] verification passed
✅ Ready for activation phase

# FAILURE INDICATORS

❌ Menu YAML missing from agent-plan
❌ Commands missing required elements (trigger/description/handler)
❌ Menu doesn't follow pattern structure
❌ Help/exit commands manually added
❌ Menu [A][P][C] verification failed
❌ Unclear command triggers or descriptions
