---
name: "e-08-edit-agent"
description: "Apply edits to agent (with or without sidecar)"

nextStepFile: "./e-09-celebrate.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{agent-name}.md"
agentFile: "{original-agent-path}"
agentBackup: "{original-agent-path}.backup"

# Template and Architecture
agentTemplate: ../templates/agent-template.md
agentArch: ../data/agent-architecture.md
agentValidation: ../data/agent-validation.md
agentCompilation: ../data/agent-compilation.md
agentMetadata: ../data/agent-metadata.md
personaProperties: ../data/persona-properties.md
principlesCrafting: ../data/principles-crafting.md
agentMenuPatterns: ../data/agent-menu-patterns.md
criticalActions: ../data/critical-actions.md

# Reference examples
noSidecarExample: ../data/reference/without-sidecar/commit-poet.agent.yaml
withSidecarExample: ../data/reference/with-sidecar/journal-keeper/journal-keeper.agent.yaml

advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Edit Step 8: Edit Agent

## STEP GOAL:

Apply all planned edits to the agent YAML file. The edit approach (with or without sidecar) is determined by the `hasSidecar` value from the edit plan.

## MANDATORY EXECUTION RULES:

- 🛑 ALWAYS create backup before modifying agent file
- 📖 CRITICAL: Read template and architecture files first
- 🔄 CRITICAL: Load editPlan and agentFile
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Load all reference files before applying edits
- 📊 Apply edits exactly as specified in editPlan
- 💾 Validate YAML after each edit
- 🎭 Handle sidecar structure if hasSidecar: true
- ➡️ Auto-advance to celebration when complete

## EXECUTION PROTOCOLS:

- 🎯 Load template, architecture, and validation files
- 📊 Read editPlan to get all planned changes
- 💾 Create backup
- 📝 Apply edits: sidecar conversion, metadata, persona, commands, critical_actions
- 🎭 Manage sidecar folder structure (if applicable)
- ✅ Validate YAML and sidecar paths
- ➡️ Auto-advance to next step

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Reference Documents

Read all files before editing:

- `{agentTemplate}` - YAML structure reference
- `{agentArch}` - Agent architecture (with/without sidecar)
- `{agentValidation}` - Validation checklist
- `{agentCompilation}` - Assembly guidelines
- `{agentMetadata}`, `{personaProperties}`, `{principlesCrafting}`
- `{agentMenuPatterns}`, `{criticalActions}`

### 2. Load Edit Plan and Agent

Read `{editPlan}` to get all planned edits.
Read `{agentFile}` to get current agent YAML.

Check the `hasSidecar` value from editPlan to determine edit approach.

### 3. Create Backup

ALWAYS backup before editing:

```bash
cp {agentFile} {agentBackup}
```

Confirm: "Backup created at: `{agentBackup}`"

### 4. Apply Edits in Sequence

For each planned edit:

**Sidecar Conversion:**

**false → true (Adding sidecar):**

- Set `hasSidecar: true`
- Add `metadata.sidecar-folder` if not present
- Add `critical_actions` section with sidecar file references
- Create sidecar directory: `{agent-folder}/{agent-name}-sidecar/`
- Create starter files: `memories.md`, `instructions.md`
- Update all references to use `{project-root}/_bmad/_memory/{sidecar-folder}/` format

**true → false (Removing sidecar):**

- Set `hasSidecar: false`
- Remove `metadata.sidecar-folder` and `metadata.sidecar-path`
- If critical_actions contains only sidecar references, remove the section
- If critical_actions contains non-sidecar activation behaviors, keep and clean sidecar references
- Remove sidecar references from menu actions
- Optionally archive sidecar folder

**Metadata Edits:**

- Apply each field change from metadataEdits
- Validate format conventions

**Persona Edits:**

- Replace persona section with new four-field persona
- Validate field purity (role ≠ identity ≠ communication_style)
- For hasSidecar: true, ensure communication_style includes memory reference patterns

**Command Edits:**

- Additions: append to commands array
- Modifications: update specific commands
- Removals: remove from commands array

**Critical Actions Edits (hasSidecar: true only):**

- Additions: append to critical_actions array
- Modifications: update specific actions
- Removals: remove from array
- Ensure all references use correct `{project-root}/_bmad/_memory/` paths

### 5. Validate After Each Edit

**For both types:**

- Confirm YAML syntax is valid after each modification

**For hasSidecar: true:**

- Validate sidecar path format
- Ensure all critical_actions reference correct paths
- Confirm sidecar folder structure exists

### 6. Document Applied Edits

Append to `{editPlan}`:

```yaml
editsApplied:
  - { edit-description }
  - { edit-description }
backup: { agentBackup }
timestamp: { YYYY-MM-DD HH:MM }
```

### 7. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save to {editPlan}, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#7-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [all edits applied and validated], will you then load and read fully `{nextStepFile}` to execute and celebrate.

---

## SUCCESS METRICS

✅ Backup created
✅ All reference files loaded
✅ All edits applied correctly
✅ YAML remains valid
✅ Sidecar structure correct (if hasSidecar: true)
✅ Sidecar paths validated (if hasSidecar: true)
✅ Edit plan tracking updated

## FAILURE MODES

❌ Backup failed
❌ YAML became invalid
❌ Sidecar paths broken (hasSidecar: true)
❌ Edits not applied as specified

---

**Auto-advancing to celebration when complete...**
