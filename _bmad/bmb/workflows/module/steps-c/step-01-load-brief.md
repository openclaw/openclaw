---
name: "step-01-load-brief"
description: "Load brief or user write-up, validate completeness"

nextStepFile: "./step-02-structure.md"
continueFile: "./step-01b-continue.md"
agentSpecTemplate: "../data/agent-spec-template.md"
workflowSpecTemplate: "../templates/workflow-spec-template.md"
moduleStandardsFile: "../data/module-standards.md"
moduleYamlConventionsFile: "../data/module-yaml-conventions.md"
advancedElicitationTask: "../../../../core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "../../../../core/workflows/party-mode/workflow.md"
---

# Step 1: Load Brief (Create Mode)

## STEP GOAL:

Load the module brief (or get a detailed user write-up) and validate it has the information needed to build the module.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Builder** — structured, competent, ready to build
- ✅ Validate input before proceeding
- ✅ Ensure we have what we need to succeed

### Step-Specific Rules:

- 🎯 This is a continuable workflow — check for existing work
- 🚫 FORBIDDEN to proceed without complete brief or write-up
- 💾 Track progress for continuation

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 📖 Create/update output file to track progress
- 🚫 FORBIDDEN to load next step until brief is validated

## CONTEXT BOUNDARIES:

- Input: Module brief from Brief mode OR user-provided write-up
- Output: Module structure ready for implementation
- This mode requires complete information to proceed

---

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly.

### 1. Check for Existing Work

Look for existing module build state:

- Check for `module-build-{module_code}.md` in output folder
- If exists AND has `stepsCompleted` → load `{continueFile}`
- If not exists → continue to step 1.2

### 2. Get the Brief or Write-Up

"**Welcome to Create mode! I'll build your module structure from your brief.**"

**"Where is your module brief?"**

Options:

- **A)** Brief from Brief mode → `{bmb_creations_output_folder}/modules/module-brief-{code}.md`
- **B)** User-provided write-up → Ask for path
- **C)** Detailed description → User describes the module now

**IF A or B:** Load and read the brief/write-up

**IF C:** Gather the needed information through conversation:

- Module name and code
- Module type (Standalone/Extension/Global)
- Agent roster (roles, names)
- Workflow list
- Key features and tools

### 3. Validate Brief Completeness

Load `{moduleStandardsFile}` and check that the brief contains:

**Required Information:**

- [ ] Module code and name
- [ ] Module type (Standalone/Extension/Global)
- [ ] Module vision/purpose
- [ ] Agent roster (at least minimum)
- [ ] Workflow list (at least core workflows)
- [ ] Any special tools or integrations

**IF Extension Module:**

- [ ] Base module code (for matching)

**IF anything missing:**

"**Your brief is missing some key information. Let me help you complete it.**"

Use `{advancedElicitationTask}` if needed to gather missing details.

### 4. Confirm and Create Tracking

Once validated:

"**I have everything I need to build your module!**"

"**Module:** {name} ({code})"
"**Type:** {Standalone/Extension/Global}"

Create or update the build tracking file:

```yaml
---
moduleCode: { code }
moduleName: { name }
moduleType: { type }
briefFile: { brief path or "user-provided" }
stepsCompleted: ["step-01-load-brief"]
created: { date }
status: IN_PROGRESS
---
```

### 5. Preview the Build Process

"**Here's what I'll build for you:**"

1. Directory structure (based on module type)
2. module.yaml with install configuration
3. Agent placeholder/spec files
4. Workflow placeholder/spec files
5. README.md and TODO.md
6. module-help.csv (generated from specs)

"**Ready to start building?**"

### 6. Present MENU OPTIONS

**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue

#### EXECUTION RULES:

- ALWAYS halt and wait for user input
- ONLY proceed to next step when user selects 'C'

#### Menu Handling Logic:

- IF A: Execute `{advancedElicitationTask}` for any refinements
- IF P: Execute `{partyModeWorkflow}` for creative pre-build discussion
- IF C: Update tracking file, then load `{nextStepFile}`
- IF Any other: Help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Brief or write-up loaded
- All required information validated
- Tracking file created
- User confirms ready to build

### ❌ SYSTEM FAILURE:

- Proceeding with incomplete brief
- Missing key information (code, type, agents, workflows)
- Not validating extension base module

**Master Rule:** Garbage in, garbage out. Ensure we have complete information before building.
