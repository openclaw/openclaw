---
name: "step-03-module-type"
description: "EARLY decision: Standalone, Extension, or Global module?"

nextStepFile: "./step-04-vision.md"
moduleStandardsFile: "../data/module-standards.md"
advancedElicitationTask: "../../../../core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "../../../../core/workflows/party-mode/workflow.md"
---

# Step 3: Module Type

## STEP GOAL:

Make the EARLY key decision: Is this a Standalone, Extension, or Global module? This decision affects everything that follows.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Architect** — you understand module types and their implications
- ✅ Help the user make an informed decision
- ✅ This is a commitment — get it right

### Step-Specific Rules:

- 🎯 This decision MUST happen early
- 🚫 FORBIDDEN to proceed without clarity on module type
- 💬 Explain the trade-offs clearly

## EXECUTION PROTOCOLS:

- 🎯 Load `{moduleStandardsFile}` to reference module types
- 🎯 Follow the MANDATORY SEQUENCE exactly
- 📖 Load next step when user selects 'C'

---

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly.

### 1. Explain Module Types

Load `{moduleStandardsFile}` and present the three types:

"**Before we go further, we need to decide: What type of module is this?** This decision affects where files go, how installation works, and how the module integrates with BMAD."

**Standalone Module:**

- A new, independent module
- Own module code and identity
- Installed alongside other modules
- Example: CIS — a creative innovation suite

**Extension Module:**

- Extends an existing BMAD module
- Shares the base module's code (e.g., `code: bmm`)
- Adds or overrides agents/workflows
- Example: A security extension for BMM

**Global Module:**

- Affects the entire BMAD framework
- Core functionality impacting all modules
- Rare — use sparingly
- Example: Universal logging/telemetry

### 2. Determine Type Together

**"Based on your idea, what type makes sense?"**

Help them think through:

- **"Is this a brand new domain?"** → Likely Standalone
- **"Does this build on an existing module?"** → Likely Extension
- **"Does this affect all modules?"** → Possibly Global (be cautious)

**If considering Extension:**

- "Which existing module does it extend?"
- "Are you adding new agents/workflows, or modifying existing ones?"
- "This means your `code:` will match the base module"

**If considering Global:**

- "Are you sure? Global modules are rare."
- "Could this be a standalone module instead?"

### 3. Confirm and Store

Once decided:

"**Module Type: {Standalone/Extension/Global}**"

**IF Extension:**
"Base module to extend: {base-module-code}"
"Folder name will be unique: {e.g., bmm-security}"

**Store this decision.** It affects:

- Where files are created
- What `code:` goes in module.yaml
- Installation behavior

### 4. Preview Implications

Briefly explain what this means:

- "As a {type}, your module will {implications}"
- "When we build, files will go to {location}"

### 5. Present MENU OPTIONS

**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue

#### EXECUTION RULES:

- ALWAYS halt and wait for user input
- User can change their mind before proceeding
- ONLY proceed to next step when user selects 'C' and confirms the type

#### Menu Handling Logic:

- IF A: Execute `{advancedElicitationTask}` for deeper exploration of the decision
- IF P: Execute `{partyModeWorkflow}` for brainstorming the approach
- IF C: Confirm the decision, then load `{nextStepFile}`
- IF Any other: Help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Module type clearly decided
- User understands the implications
- Extension modules know their base module
- Decision is stored for later steps

### ❌ SYSTEM FAILURE:

- Proceeding without clear module type
- User doesn't understand the implications
- Extension module without clear base

**Master Rule:** This is a gateway decision. Get clarity before moving forward.
