---
name: "step-06-activation"
description: "Plan activation behavior and route to build"

# File References
agentPlan: "{bmb_creations_output_folder}/agent-plan-{agent_name}.md"
criticalActions: ../data/critical-actions.md

# Build Step Route (determined by hasSidecar)
agentBuild: "./step-07-build-agent.md"

# Example critical_actions (for reference)
withSidecarExample: ../data/reference/with-sidecar/journal-keeper/journal-keeper.agent.yaml
withoutSidecarExample: ../data/reference/without-sidecar/commit-poet.agent.yaml

# Task References
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# STEP GOAL

Define activation behavior through critical_actions and confirm routing to the build step based on hasSidecar decision.

# MANDATORY EXECUTION RULES

1. **MUST Load Reference Documents** Before any discussion
   - Read criticalActions.md to understand activation patterns
   - Read agentPlan to access all accumulated metadata
   - These are non-negotiable prerequisites

2. **MUST Confirm hasSidecar Decision**
   - Check `hasSidecar` from plan metadata (decided in Step 3)
   - This determines the build approach
   - Inform user of routing decision

3. **MUST Document Activation Decision**
   - Either define critical_actions array explicitly
   - OR document deliberate omission with rationale
   - No middle ground - commit to one path

4. **MUST Follow Simple Routing Logic**

   ```yaml
   # Route determination based on hasSidecar only
   hasSidecar: false → Agent without sidecar (single YAML file)
   hasSidecar: true → Agent with sidecar (YAML + sidecar folder)
   ```

5. **NEVER Skip Documentation**
   - Every decision about activation must be recorded
   - Every routing choice must be justified
   - Plan file must reflect final state

# EXECUTION PROTOCOLS

## Protocol 1: Reference Loading

Execute BEFORE engaging user:

1. Load criticalActions.md
2. Load agentPlan-{agent_name}.md
3. Extract routing metadata:
   - hasSidecar (boolean) - decided in Step 3
   - All other metadata from prior steps
4. Confirm build approach

## Protocol 2: Routing Disclosure

Inform user immediately of determined route:

```
"Based on your agent configuration:
- hasSidecar: {hasSidecar}

→ Building: Agent {WITH|WITHOUT} sidecar

Now let's plan your activation behavior..."
```

## Protocol 3: Activation Planning

Guide user through decision:

1. **Explain critical_actions Purpose**
   - What they are: autonomous triggers the agent can execute
   - When they're useful: proactive capabilities, workflows, utilities
   - When they're unnecessary: simple assistants, pure responders

2. **Discuss Agent's Activation Needs**
   - Does this agent need to run independently?
   - Should it initiate actions without prompts?
   - What workflows or capabilities should it trigger?

3. **Decision Point**
   - Define specific critical_actions if needed
   - OR explicitly opt-out with rationale

## Protocol 4: Documentation

Update agentPlan with activation metadata:

```yaml
# Add to agent metadata
activation:
  hasCriticalActions: true/false
  rationale: "Explanation of why or why not"
  criticalActions: [] # Only if hasCriticalActions: true

routing:
  buildApproach: "Agent {with|without} sidecar"
  hasSidecar: { boolean }
```

# CONTEXT BOUNDARIES

## In Scope

- Planning activation behavior for the agent
- Defining critical_actions array
- Confirming routing to build step
- Documenting activation decisions

## Out of Scope

- Writing actual activation code (build step)
- Designing sidecar workflows (build step)
- Changing core agent metadata (locked after Step 4)
- Implementing commands (build step)

## Routing Boundaries

- **Agent WITHOUT sidecar**: Single YAML file, no persistent memory
- **Agent WITH sidecar**: YAML file + sidecar folder with persistent memory

---

# MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

## 1. Load Reference Documents

```bash
# Read these files FIRST
cat {criticalActions}
cat {agentPlan}
```

## 2. Confirm Routing Decision

Verify hasSidecar decision from Step 3:

```
"Confirming your agent configuration from Step 3:
- hasSidecar: {value from plan}
- This means: {Agent will|will not} remember things between sessions
- Build approach: {Single YAML file|YAML + sidecar folder}

Is this still correct?"
```

## 3. Discuss Activation Needs

Ask user:

- "Should your agent be able to take autonomous actions?"
- "Are there specific workflows it should trigger?"
- "Should it run as a background process or scheduled task?"
- "Or will it primarily respond to direct prompts?"

## 4. Define critical_actions OR Explicitly Omit

**If defining:**

- Reference criticalActions.md patterns
- List 3-7 specific actions
- Each action should be clear and scoped
- Document rationale for each

**For agents WITH sidecar, critical_actions MUST include:**

```
- "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/memories.md"
- "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/instructions.md"
- "ONLY read/write files in {project-root}/_bmad/_memory/{sidecar-folder}/ - private space"
```

Plus any additional activation behaviors the agent needs.

**For agents WITHOUT sidecar, critical_actions are OPTIONAL and can include:**

```
- "Give user an inspirational quote before showing menu"
- "Fetch latest data from {project-root}/finances/ before displaying menu"
- "Display a quick status summary on activation"
```

Agents without sidecar omit critical_actions entirely if no activation behavior is needed.

**If omitting:**

- State clearly: "This agent will not have critical_actions"
- Explain why: "This agent is a responsive assistant that operates under direct user guidance"
- Document the rationale

## 5. Document to Plan

Update agentPlan with:

```yaml
---
activation:
  hasCriticalActions: {true/false}
  rationale: "Agent needs to autonomously trigger workflows for task automation" OR "Agent operates under direct user guidance"
  criticalActions:
    - name: "start-workflow"
      description: "Initiate a predefined workflow for task execution"
    # ... additional actions if needed

routing:
  buildApproach: "Agent {with|without} sidecar"
  hasSidecar: {true/false}
  rationale: "Agent {needs|does not need} persistent memory across sessions"
---
```

### 6. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save content to {agentPlan}, update frontmatter, then only then load, read entire file, then execute {agentBuild}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#6-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

This is the **final planning step** before building. ONLY WHEN [C continue option] is selected and [activation needs documented], will you then load and read fully `{agentBuild}` to execute and build the agent.

Routing logic:

- hasSidecar: false → Agent WITHOUT sidecar (single YAML)
- hasSidecar: true → Agent WITH sidecar (YAML + sidecar folder)

You cannot proceed to build without completing activation planning.

---

# SUCCESS METRICS

✅ **COMPLETION CRITERIA:**

- [ ] criticalActions.md loaded and understood
- [ ] agentPlan loaded with all prior metadata
- [ ] Routing decision confirmed (hasSidecar from Step 3)
- [ ] Activation needs discussed with user
- [ ] critical_actions defined OR explicitly omitted with rationale
- [ ] Plan updated with activation and routing metadata
- [ ] User confirms ready to build

✅ **SUCCESS INDICATORS:**

- Clear activation decision documented
- Route to build is unambiguous
- User understands the build approach
- Plan file reflects complete activation configuration

❌ **FAILURE MODES:**

- Attempting to define critical_actions without reading reference
- Routing decision not documented in plan
- User doesn't understand the build approach
- Ambiguous activation configuration (neither defined nor omitted)
- Skipping activation discussion entirely

⚠️ **RECOVERY PATHS**
If activation planning goes wrong:

1. **Can't decide on activation?**
   - Default: Omit critical_actions
   - Can add later via edit-agent workflow

2. **User wants to change hasSidecar?**
   - Return to Step 3 to revise decision
   - Update plan accordingly

3. **Uncertain about routing?**
   - Check hasSidecar value
   - Apply simple routing logic
