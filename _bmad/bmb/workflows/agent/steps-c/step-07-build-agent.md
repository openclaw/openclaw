---
name: "step-07-build-agent"
description: "Generate agent YAML from plan (with or without sidecar)"

# File References
nextStepFile: "./step-08-celebrate.md"
agentPlan: "{bmb_creations_output_folder}/agent-plan-{agent_name}.md"

# Output paths (determined by hasSidecar)
agentBuildOutput: "{bmb_creations_output_folder}/{agent-name}/"
agentYamlOutput: "{bmb_creations_output_folder}/{agent-name}/{agent-name}.agent.yaml"
agentYamlOutputNoSidecar: "{bmb_creations_output_folder}/{agent-name}.agent.yaml"
sidecarOutput: "{bmb_creations_output_folder}/{agent-name}/{agent-name}-sidecar/"

# Template and Architecture
agentTemplate: ../templates/agent-template.md
agentArch: ../data/agent-architecture.md
agentCompilation: ../data/agent-compilation.md
criticalActions: ../data/critical-actions.md

# Reference examples
noSidecarExample: ../data/reference/without-sidecar/commit-poet.agent.yaml
withSidecarExample: ../data/reference/with-sidecar/journal-keeper/journal-keeper.agent.yaml

# Task References
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# STEP GOAL

Assemble the agent plan content into a complete agent YAML file. The build approach (with or without sidecar) is determined by the `hasSidecar` decision made in Step 3.

---

# MANDATORY EXECUTION RULES

1. **DETERMINE BUILD APPROACH FIRST**: Check `hasSidecar` from agentPlan before starting
2. **TEMPLATE COMPLIANCE**: Follow agent-template.md structure exactly
3. **YAML VALIDATION**: Ensure valid YAML syntax with proper indentation (2-space)
4. **EXISTING CHECK**: If output file exists, ask user before overwriting
5. **NO DRIFT**: Use ONLY content from agentPlan - no additions or interpretations
6. **SIDECAR REQUIREMENT**: If hasSidecar=true, MUST create sidecar folder structure

---

# EXECUTION PROTOCOLS

## Phase 1: Load Architecture and Templates

1. Read `agentTemplate` - defines YAML structure for agents
2. Read `agentArch` - architecture requirements for agents
3. Read `agentCompilation` - assembly rules for YAML generation
4. Read `criticalActions` - validation requirements for critical_actions

## Phase 2: Load Agent Plan

1. Read `agentPlan` containing all collected content from Steps 2-5
2. Verify plan contains:
   - hasSidecar decision (true/false)
   - Persona content
   - Commands structure
   - All metadata fields
   - Activation decisions (critical_actions)

## Phase 3: Determine Build Approach

Check `hasSidecar` from plan:

```yaml
hasSidecar: false
→ Build: Agent WITHOUT sidecar
→ Output: Single YAML file at {agentYamlOutputNoSidecar}
→ Structure: Everything in one file (~250 lines max)

hasSidecar: true
→ Build: Agent WITH sidecar
→ Output: YAML + sidecar folder structure
→ Structure: YAML file + {agent-name}-sidecar/ folder
```

**Inform user of build approach:**

```
"Building: Agent {WITH|WITHOUT} sidecar
hasSidecar: {true/false}
Output: {output path description}"
```

## Phase 4: Assemble Agent YAML

### For Agents WITHOUT Sidecar (hasSidecar: false)

**Structure:**

```yaml
name: "{agent-name}"
description: "{short-description}"

author:
  name: "{author}"
  created: "{date}"

persona: |
  {multi-line persona content from plan}

system-context: |
  {expanded context from plan}

capabilities:
  - { capability from plan }
  - { capability from plan }
  # ... all capabilities

commands:
  - name: "{command-name}"
    description: "{what command does}"
    trigger: "{menu trigger}"
    steps:
      - { step 1 }
      - { step 2 }
    # ... all commands from plan

configuration:
  temperature: { temperature }
  max-tokens: { max-tokens }
  response-format: { format }
  # ... other configuration from plan

metadata:
  hasSidecar: false
  agent-type: "agent"
```

**Output:** Single YAML file at `{agentYamlOutputNoSidecar}`

### For Agents WITH Sidecar (hasSidecar: true)

**Structure:**

```yaml
name: "{agent-name}"
description: "{short-description}"

author:
  name: "{author}"
  created: "{date}"

persona: |
  {multi-line persona content from plan}

system-context: |
  {expanded context from plan}

capabilities:
  - { capability from plan }
  - { capability from plan }
  # ... all capabilities

critical-actions:
  - name: "{action-name}"
    description: "{what it does}"
    invocation: "{when/how to invoke}"
    implementation: |
      {multi-line implementation}
    output: "{expected-output}"
    sidecar-folder: "{sidecar-folder-name}"
    sidecar-files:
      - "{project-root}/_bmad/_memory/{sidecar-folder}/{file1}.md"
      - "{project-root}/_bmad/_memory/{sidecar-folder}/{file2}.md"
  # ... all critical actions referencing sidecar structure

commands:
  - name: "{command-name}"
    description: "{what command does}"
    trigger: "{menu trigger}"
    steps:
      - { step 1 }
      - { step 2 }
    # ... all commands from plan

configuration:
  temperature: { temperature }
  max-tokens: { max-tokens }
  response-format: { format }
  # ... other configuration from plan

metadata:
  sidecar-folder: "{sidecar-folder-name}"
  sidecar-path: "{project-root}/_bmad/_memory/{sidecar-folder}/"
  hasSidecar: true
  agent-type: "agent"
  memory-type: "persistent"
```

**Output:** YAML file at `{agentYamlOutput}` + sidecar folder structure

### Phase 5: Create Sidecar Structure (IF hasSidecar: true)

Skip this phase if hasSidecar: false

1. **Create Sidecar Directory**:

   ```bash
   mkdir -p {sidecarOutput}
   ```

2. **Create Starter Files** (if specified in critical_actions):

   ```bash
   touch {sidecarOutput}/memories.md
   touch {sidecarOutput}/instructions.md
   # ... additional files from critical_actions
   ```

3. **Add README to Sidecar**:

   ```markdown
   # {sidecar-folder} Sidecar

   This folder stores persistent memory for the **{agent-name}** agent.

   ## Purpose

   {purpose from critical_actions}

   ## Files

   - memories.md: User profile, session history, patterns
   - instructions.md: Protocols, boundaries, startup behavior
   - {additional files}

   ## Runtime Access

   After BMAD installation, this folder will be accessible at:
   `{project-root}/_bmad/_memory/{sidecar-folder}/{filename}.md`
   ```

### Phase 6: Write Agent YAML

**If hasSidecar: false:**

1. Write YAML to `{agentYamlOutputNoSidecar}`
2. Confirm write success
3. Display file location to user

**If hasSidecar: true:**

1. Create directory: `mkdir -p {agentBuildOutput}`
2. Write YAML to `{agentYamlOutput}`
3. Confirm write success
4. Display file location to user

## Phase 7: Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Write agent YAML to appropriate output path (with or without sidecar), update frontmatter, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#7-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options

---

# CONTEXT BOUNDARIES

**INCLUDE:**

- Template structure exactly as provided
- All agent metadata from agentPlan
- Persona, commands, and rules from plan
- Configuration options specified
- Sidecar structure if hasSidecar: true

**EXCLUDE:**

- Any content not in agentPlan
- Sidecar references if hasSidecar: false
- Template placeholders (replace with actual content)
- Comments or notes in final YAML

---

# CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [complete YAML generated and written to output], will you then load and read fully `{nextStepFile}` to execute and celebrate completion.

**This step produces:**

- **If hasSidecar: false**: Single agent YAML file
- **If hasSidecar: true**: Agent YAML file + sidecar folder structure

Both must exist (if applicable) before proceeding to validation.

---

# SUCCESS METRICS

✅ **SUCCESS looks like:**

- Agent YAML file exists at specified output path
- YAML is syntactically valid and well-formed
- All template fields populated with plan content
- Structure matches agent architecture
- If hasSidecar: true, sidecar folder created with starter files
- User has selected continue to proceed

❌ **FAILURE looks like:**

- Template or architecture files not found
- Agent plan missing required sections
- YAML syntax errors in output
- Content not properly mapped to template
- File write operation fails
- hasSidecar: true but sidecar folder not created

---

# TRANSITION CRITERIA

**Ready for Step 8 when:**

- Agent YAML successfully created (with or without sidecar as specified)
- User selects continue
- All build artifacts confirmed written
