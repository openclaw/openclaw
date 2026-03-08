---
name: module-help-generate
description: Generate or update module-help.csv for any BMad module with proper structure
web_bundle: false

# Path variables (to be set by caller)
modulePath: "{module_path}"
moduleYamlFile: "{module_path}/module.yaml"
moduleHelpCsvFile: "{module_path}/module-help.csv"
workflowsDir: "{module_path}/workflows"
agentsDir: "{module_path}/agents"
---

# Module Help CSV Generator

**Goal:** Generate or update a `module-help.csv` file that serves as the central registry for all module functionality - workflows, agents, and commands.

**Your Role:** You are a Module Documentation Architect. You will analyze a module's structure and create a properly formatted CSV that enables discoverability and CLI integration.

---

## CRITICAL RULES (NO EXCEPTIONS)

- ALWAYS read existing `module-help.csv` first if it exists - update/validate rather than replace
- ALWAYS read `module.yaml` to get module code and type
- ALWAYS read ALL agent `.yaml` files to understand menu triggers
- ALWAYS read ALL workflow `workflow.md` files to understand purpose
- ALWAYS place `anytime` entries at the TOP with EMPTY sequence
- ALWAYS place phased entries BELOW anytime entries
- ALWAYS number phases starting at `-1` (phase-1, phase-2, phase-3...)
- ALWAYS leave sequence EMPTY for `anytime` entries (user chooses, not ordered)
- ALWAYS include sequence number for phased entries (defines order within phase)
- ALWAYS use EMPTY `workflow-file` for agent-only menu triggers
- ALWAYS include `agent` column for agent-based features
- NEVER assume workflow paths - verify from actual file structure
- ALWAYS search for and put the file at the root of the module ONLY

---

## CSV STRUCTURE (13 columns)

```
module,phase,name,code,sequence,workflow-file,command,required,agent,options,description,output-location,outputs,
```

| Column            | Purpose                                 | Rules                                  |
| ----------------- | --------------------------------------- | -------------------------------------- |
| `module`          | Module code from `module.yaml`          | Required                               |
| `phase`           | `anytime` or `phase-1`, `phase-2`, etc. | Phases start at -1                     |
| `name`            | Display name of the feature             | User-facing                            |
| `code`            | Short code for commands                 | Unique within module                   |
| `sequence`        | Order within phase                      | EMPTY for anytime, number for phases   |
| `workflow-file`   | Path to workflow.md                     | EMPTY for agent-only                   |
| `command`         | Internal command name                   | Format: `{module_code}_{feature_code}` |
| `required`        | Whether required                        | Usually `false`                        |
| `agent`           | Associated agent name                   | From agent YAML metadata               |
| `options`         | Mode or action type                     | e.g., "Create Mode", "Chat Mode"       |
| `description`     | User-facing description                 | Explain what and when to use           |
| `output-location` | Where output goes                       | Folder name or EMPTY                   |
| `outputs`         | What is produced                        | Output type or EMPTY                   |

---

## PHASE AND SEQUENCING RULES

### 1. anytime

- Use for: standalone features, agent menu triggers, unrelated utilities
- Place at TOP of file
- `sequence` column MUST BE EMPTY
- User chooses what to run - no order

### 2. Phases (phase-1, phase-2, phase-3...)

- Use for: sequential workflows, guided processes
- Place BELOW anytime entries
- Phases ALWAYS start at `-1` (not 0 or 1)
- `sequence` defines order WITHIN phase (10, 20, 30...)
- the name can be named differently than just phase but should be dash number at the end if sequence is needed

### 3. Module Integration Patterns

**Full module with phases:**

```
anytime entries (sequence empty)
phase-1 entries (sequence 10, 20, 30...)
phase-2 entries (sequence 10, 20, 30...)
```

**Add-on to existing module:**

```
May only have phase-3 entries that integrate into another module's workflow
Sequence numbers fit logically before/after existing items
```

**Standalone collections:**

```
All entries are anytime
No sequence numbers
User picks one as needed
```

**Agent-only features:**

```
Empty workflow-file column
Agent handles everything via its menu
```

---

## EXECUTION SEQUENCE

### Step 1: Identify Target Module

Ask user:

1. What is the path to the module?
2. Or should we scan for modules in the workspace?

### Step 2: Read Module Configuration

Load and read:

```
{moduleYamlFile}
```

Extract:

- `code` - Module identifier
- `type` - Module type
- `name` - Module display name

### Step 3: Check for Existing module-help.csv

Check if exists:

```
{moduleHelpCsvFile}
```

**If exists:**

- Read entire file
- Parse all existing entries
- Ask user: Update existing, validate, or regenerate?

**If not exists:**

- Note: Will create new file
- Proceed to discovery

### Step 4: Discover All Workflows

Scan the workflows directory:

```
{workflowsDir}
```

For each workflow found:

- Read the `workflow.md` file
- Extract: name, description, goal, role
- Note the relative path for CSV entry

### Step 5: Discover All Agents

Scan the agents directory:

```
{agentsDir}
```

For each agent found:

- Read the `.agent.yaml` file
- Extract: metadata (name, title), persona, menu triggers
- Identify agent-only triggers (no workflow route)
- Identify workflow-routing triggers

### Step 6: Determine Phasing Strategy

Analyze the module and decide:

**Question for each workflow:**

- Is this part of a sequential journey? → Use phases
- Is this standalone/optional? → Use anytime
- Can user do this anytime? → Use anytime

**For agent menu items:**

- Does it route to a workflow? → Map to that workflow or anytime
- Is it an inline action? → anytime, no workflow file

### Step 7: Generate CSV Content

Build the CSV following structure:

**Header:**

```
module,phase,name,code,sequence,workflow-file,command,required,agent,options,description,output-location,outputs,
```

**Entry Rules:**

1. ALL `anytime` entries FIRST - `sequence` EMPTY
2. THEN phased entries - `phase-1`, `phase-2`, etc.
3. Within phases, `sequence` orders execution (10, 20, 30...)
4. Agent-only actions: empty `workflow-file`, specify `agent`

**Code Format:**

- Command: `{module_code}_{feature_name}`
- Keep codes short but memorable (2-3 letters usually)

**Description Guidance:**

- Explain WHAT the feature does
- Include WHEN to use it (especially for phased items)
- For add-on modules: "Best used after X but before Y"

### Step 8: Present to User

Before writing:

1. Show the CSV content in a readable table format
2. Explain phasing decisions
3. Highlight any agent-only entries
4. Ask for confirmation or adjustments

### Step 9: Write File

On confirmation:

```
Write to: {moduleHelpCsvFile}
```

---

## EXAMPLE OUTPUT STRUCTURE

### Full Module with Phases (like mwm):

```csv
module,phase,name,code,sequence,workflow-file,command,required,agent,options,description,output-location,outputs,
mwm,anytime,Chat with Wellness,CWC,,"mwm_chat",false,wellness-companion,Chat Mode,"Have a supportive conversation anytime",,,
mwm,anytime,Quick Breathing,QB,,"mwm_breathing",false,meditation-guide,Breathing,"Quick 4-7-8 breathing exercise",,,
mwm,phase-1,Daily Check In,DCI,10,_bmad/mwm/workflows/daily-checkin/workflow.md,mwm_daily_checkin,false,wellness-companion,Check In Mode,"Start your day with wellness check-in",mwm_output,"summary",
mwm,phase-2,Wellness Journal,WJ,20,_bmad/mwm/workflows/wellness-journal/workflow.md,mwm_journal,false,wellness-companion,Journal Mode,"Reflect and track your wellness journey",mwm_output,"entry",
```

### Standalone Module (like bmad-custom):

```csv
module,phase,name,code,sequence,workflow-file,command,required,agent,options,description,output-location,outputs,
bmad-custom,anytime,Quiz Master,QM,,"bmad_quiz",false,,Trivia,"Interactive trivia quiz with gameshow atmosphere",bmad_output,"results",
bmad-custom,anytime,Wassup,WS,,"bmad_wassup",false,,Status,"Check uncommitted changes and suggest commits",bmad_output,"summary",
bmad-custom,anytime,Write Commit,WC,,"bmad_write_commit",false,commit-poet,Write,"Craft a commit message from your changes",bmad_output,"message",
```

---

## INITIALIZATION

To begin this workflow:

1. Ask user for the target module path if not provided
2. Load and read `module.yaml` in the root of the target if it exists
3. Check for existing `module-help.csv`
4. Scan for all workflows and agents
5. Generate CSV following all rules above
6. Update the file and review with the user - never auto commit and push
