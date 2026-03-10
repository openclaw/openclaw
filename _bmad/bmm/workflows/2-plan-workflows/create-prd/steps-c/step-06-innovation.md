---
name: 'step-06-innovation'
description: 'Detect and explore innovative aspects of the product (optional step)'

# File References
nextStepFile: '{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-prd/steps-c/step-07-project-type.md'
outputFile: '{planning_artifacts}/prd.md'

# Data Files
projectTypesCSV: '{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-prd/data/project-types.csv'

# Task References
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
---

# Step 6: Innovation Discovery

**Progress: Step 6 of 11** - Next: Project Type Analysis

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between PM peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on detecting and exploring innovative aspects of the product
- 🎯 OPTIONAL STEP: Only proceed if innovation signals are detected
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ⚠️ Present A/P/C menu after generating innovation content
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update output file frontmatter, adding this step name to the end of the list of stepsCompleted
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- Project type from step-02 is available for innovation signal matching
- Project-type CSV data will be loaded in this step
- Focus on detecting genuine innovation, not forced creativity

## OPTIONAL STEP CHECK:

Before proceeding with this step, scan for innovation signals:

- Listen for language like "nothing like this exists", "rethinking how X works"
- Check for project-type innovation signals from CSV
- Look for novel approaches or unique combinations
- If no innovation detected, skip this step

## YOUR TASK:

Detect and explore innovation patterns in the product, focusing on what makes it truly novel and how to validate the innovative aspects.

## INNOVATION DISCOVERY SEQUENCE:

### 1. Load Project-Type Innovation Data

Load innovation signals specific to this project type:

- Load `{projectTypesCSV}` completely
- Find the row where `project_type` matches detected type from step-02
- Extract `innovation_signals` (semicolon-separated list)
- Extract `web_search_triggers` for potential innovation research

### 2. Listen for Innovation Indicators

Monitor conversation for both general and project-type-specific innovation signals:

#### General Innovation Language:

- "Nothing like this exists"
- "We're rethinking how [X] works"
- "Combining [A] with [B] for the first time"
- "Novel approach to [problem]"
- "No one has done [concept] before"

#### Project-Type-Specific Signals (from CSV):

Match user descriptions against innovation_signals for their project_type:

- **api_backend**: "API composition;New protocol"
- **mobile_app**: "Gesture innovation;AR/VR features"
- **saas_b2b**: "Workflow automation;AI agents"
- **developer_tool**: "New paradigm;DSL creation"

### 3. Initial Innovation Screening

Ask targeted innovation discovery questions:
- Guide exploration of what makes the product innovative
- Explore if they're challenging existing assumptions
- Ask about novel combinations of technologies/approaches
- Identify what hasn't been done before
- Understand which aspects feel most innovative

### 4. Deep Innovation Exploration (If Detected)

If innovation signals are found, explore deeply:

#### Innovation Discovery Questions:
- What makes it unique compared to existing solutions?
- What assumption are you challenging?
- How do we validate it works?
- What's the fallback if it doesn't?
- Has anyone tried this before?

#### Market Context Research:

If relevant innovation detected, consider web search for context:
Use `web_search_triggers` from project-type CSV:
`[web_search_triggers] {concept} innovations {date}`

### 5. Generate Innovation Content (If Innovation Detected)

Prepare the content to append to the document:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Innovation & Novel Patterns

### Detected Innovation Areas

[Innovation patterns identified based on conversation]

### Market Context & Competitive Landscape

[Market context and research based on conversation]

### Validation Approach

[Validation methodology based on conversation]

### Risk Mitigation

[Innovation risks and fallbacks based on conversation]
```

### 6. Present MENU OPTIONS (Only if Innovation Detected)

Present the innovation content for review, then display menu:
- Show identified innovative aspects (using structure from section 5)
- Highlight differentiation from existing solutions
- Ask if they'd like to refine further, get other perspectives, or proceed
- Present menu options naturally as part of conversation

Display: "**Select:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Project Type Analysis (Step 7 of 11)"

#### Menu Handling Logic:
- IF A: Read fully and follow: {advancedElicitationTask} with the current innovation content, process the enhanced innovation insights that come back, ask user "Accept these improvements to the innovation analysis? (y/n)", if yes update content with improvements then redisplay menu, if no keep original content then redisplay menu
- IF P: Read fully and follow: {partyModeWorkflow} with the current innovation content, process the collaborative innovation exploration and ideation, ask user "Accept these changes to the innovation analysis? (y/n)", if yes update content with improvements then redisplay menu, if no keep original content then redisplay menu
- IF C: Append the final content to {outputFile}, update frontmatter by adding this step name to the end of the stepsCompleted array, then read fully and follow: {nextStepFile}
- IF Any other: help user respond, then redisplay menu

#### EXECUTION RULES:
- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

## NO INNOVATION DETECTED:

If no genuine innovation signals are found after exploration:
- Acknowledge that no clear innovation signals were found
- Note this is fine - many successful products are excellent executions of existing concepts
- Ask if they'd like to try finding innovative angles or proceed

Display: "**Select:** [A] Advanced Elicitation - Let's try to find innovative angles [C] Continue - Skip innovation section and move to Project Type Analysis (Step 7 of 11)"

### Menu Handling Logic:
- IF A: Proceed with content generation anyway, then return to menu
- IF C: Skip this step, then read fully and follow: {nextStepFile}

### EXECUTION RULES:
- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 5.

## SUCCESS METRICS:

✅ Innovation signals properly detected from user conversation
✅ Project-type innovation signals used to guide discovery
✅ Genuine innovation explored (not forced creativity)
✅ Validation approach clearly defined for innovative aspects
✅ Risk mitigation strategies identified
✅ A/P/C menu presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Forced innovation when none genuinely exists
❌ Not using project-type innovation signals from CSV
❌ Missing market context research for novel concepts
❌ Not addressing validation approach for innovative features
❌ Creating innovation theater without real innovative aspects
❌ Not presenting A/P/C menu after content generation
❌ Appending content without user selecting 'C'

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## SKIP CONDITIONS:

Skip this step and load `{nextStepFile}` if:

- No innovation signals detected in conversation
- Product is incremental improvement rather than breakthrough
- User confirms innovation exploration is not needed
- Project-type CSV has no innovation signals for this type

## NEXT STEP:

After user selects 'C' and content is saved to document (or step is skipped), load `{nextStepFile}`.

Remember: Do NOT proceed to step-07 until user explicitly selects 'C' from the A/P/C menu (or confirms step skip)!
