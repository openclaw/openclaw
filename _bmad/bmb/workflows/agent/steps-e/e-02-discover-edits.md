---
name: "e-02-discover-edits"
description: "Discover what user wants to change about the agent"

nextStepFile: "./e-04-sidecar-metadata.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{agent-name}.md"

advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Edit Step 2: Discover Edits

## STEP GOAL:

Conduct targeted discovery to understand exactly what the user wants to change about their agent. Document all requested edits in structured format.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER assume what edits are needed - ask explicitly
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: Read editPlan first to understand agent context
- 📋 YOU ARE A FACILITATOR, not an autonomous editor
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are an agent editor consultant who helps users clarify their modification goals
- ✅ If you already have been given a name, communication_style and identity, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring agent architecture expertise, user brings their vision for improvements, together we define precise edits
- ✅ Maintain collaborative inquisitive tone throughout

### Step-Specific Rules:

- 🎯 Focus only on discovering what to edit, not how to implement yet
- 🚫 FORBIDDEN to make any modifications in this step
- 💬 Approach: Ask probing questions to understand edit scope
- 📋 Ensure all edits are documented to edit plan before proceeding

## EXECUTION PROTOCOLS:

- 🎯 Guide conversation to uncover all desired changes
- 📊 Categorize edits by component (persona, commands, metadata, etc.)
- 💾 Document all edits to edit plan
- 🚫 FORBIDDEN to proceed without confirming all edits are captured

## CONTEXT BOUNDARIES:

- Available context: editPlan with agent snapshot from previous step
- Focus: Discover what changes user wants to make
- Limits: Discovery and documentation only, no implementation
- Dependencies: Agent must be loaded in editPlan

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Read Edit Plan Context

**Load the editPlan file first:**
Read `{editPlan}` to understand the current agent structure and context.

### 2. Present Edit Categories

**Guide the user through potential edit areas:**

"What would you like to change about **{agent-name}**?

I can help you modify:

**[P]ersona** - Role, identity, communication style, principles
**[C]ommands** - Add, remove, or modify commands and menu structure
**[M]etadata** - Name, description, version, tags, category
**[S]idecar** - Add or remove memory (convert hasSidecar: true/false)
**[A]ctions** - Critical actions and activation behaviors
**[O]ther** - Configuration, capabilities, system context

Which areas would you like to edit? (You can select multiple)"

### 3. Deep Dive Discovery

**For each selected category, ask targeted questions:**

#### If Persona selected:

- "What aspect of the persona needs change?"
- "Should the role be more specific or expanded?"
- "Is the communication style hitting the right tone?"
- "Do the principles need refinement?"

#### If Commands selected:

- "Do you want to add new commands, remove existing ones, or modify?"
- "Are current command names and descriptions clear?"
- "Should command steps be adjusted?"
- "Is the menu structure working well?"

#### If Metadata selected:

- "What metadata fields need updating?"
- "Is the description accurate and compelling?"
- "Should version be bumped?"
- "Are tags still relevant?"

#### If Actions selected:

- "What critical actions need modification?"
- "Should new activation behaviors be added?"
- "Are current actions executing as expected?"

#### If Sidecar selected:

- "Do you want to add memory (hasSidecar: true) or remove it (hasSidecar: false)?"
- "What should the agent remember across sessions?"
- "Are you aware of the implications?"

### 4. Document Edits to Plan

**After discovery, append to editPlan:**

```markdown
## Edits Planned

### Persona Edits

- [ ] {edit description}
- [ ] {edit description}

### Command Edits

- [ ] {edit description}
- [ ] {edit description}

### Metadata Edits

- [ ] {edit description}
- [ ] {edit description}

### Critical Action Edits

- [ ] {edit description}
- [ ] {edit description}

### Sidecar Conversion

- [ ] {from: hasSidecar: false, to: hasSidecar: true, rationale: ...}
- [ ] {from: hasSidecar: true, to: hasSidecar: false, rationale: ...}

### Other Edits

- [ ] {edit description}
```

**Present summary for confirmation:**

"Here's what I heard you want to change:

{Summarize all edits in clear bulleted list}

Did I capture everything? Any edits to add, remove, or clarify?"

### 5. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Validation"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save edits to {editPlan}, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#5-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [all edits documented and confirmed by user], will you then load and read fully `{nextStepFile}` to execute and checks.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All desired edits discovered and documented
- Edits categorized by component type
- User confirmed edit list is complete
- Edit plan updated with structured edits

### ❌ SYSTEM FAILURE:

- Proceeding without documenting edits
- Missing edits that user mentioned
- Unclear or ambiguous edit descriptions
- User not given opportunity to review/edit list

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
