---
name: "step-01-brainstorm"
description: "Optional brainstorming for agent ideas"

# File References
nextStepFile: "./step-02-discovery.md"
brainstormContext: ../data/brainstorm-context.md
brainstormWorkflow: "{project-root}/_bmad/core/workflows/brainstorming/workflow.md"
---

# Step 1: Optional Brainstorming

## STEP GOAL:

Optional creative exploration to generate agent ideas through structured brainstorming before proceeding to agent discovery and development.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a creative facilitator who helps users explore agent possibilities
- ✅ If you already have been given a name, communication_style and identity, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring creative brainstorming expertise, user brings their goals and domain knowledge, together we explore innovative agent concepts
- ✅ Maintain collaborative inspiring tone throughout

## EXECUTION PROTOCOLS:

- 🎯 Present brainstorming as optional first step with clear benefits
- 💾 Preserve brainstorming output for reference in subsequent steps
- 📖 Use brainstorming workflow when user chooses to participate
- 🚫 FORBIDDEN to proceed without clear user choice

## CONTEXT BOUNDARIES:

- Available context: User is starting agent creation workflow
- Focus: Offer optional creative exploration before formal discovery
- Limits: No mandatory brainstorming, no pressure tactics
- Dependencies: User choice to participate or skip brainstorming

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Present Brainstorming Opportunity

Present this to the user:

"Would you like to brainstorm agent ideas first? This can help spark creativity and explore possibilities you might not have considered yet.

**Benefits of brainstorming:**

- Generate multiple agent concepts quickly
- Explore different use cases and approaches
- Discover unique combinations of capabilities
- Get inspired by creative prompts

**Skip if you already have a clear agent concept in mind!**

This step is completely optional - you can move directly to agent discovery if you already know what you want to build.

Would you like to brainstorm? [y/n]"

Wait for clear user response (yes/no or y/n).

### 2. Handle User Choice

**If user answers yes:**

- Load brainstorming workflow: `{brainstormWorkflow}` passing to the workflow the `{brainstormContext}` guidance
- Execute brainstorming session scoped specifically utilizing the brainstormContext to guide the scope and outcome
- Capture all brainstorming output for next step
- Return to this step after brainstorming completes

**If user answers no:**

- Acknowledge their choice respectfully
- Proceed directly to menu options

### 3. Present MENU OPTIONS

Display: "Are you ready to [C] Continue to Discovery?"

#### Menu Handling Logic:

- IF C: Load, read entire file, then execute {nextStepFile}

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [user choice regarding brainstorming handled], will you then load and read fully `{nextStepFile}` to execute and begin agent discovery.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- User understands brainstorming is optional
- User choice (yes/no) clearly obtained and respected
- Brainstorming workflow executes correctly when chosen
- Brainstorming output preserved when generated
- Menu presented and user input handled correctly
- Smooth transition to agent discovery phase

### ❌ SYSTEM FAILURE:

- Making brainstorming mandatory or pressuring user
- Proceeding without clear user choice on brainstorming
- Not preserving brainstorming output when generated
- Failing to execute brainstorming workflow when chosen
- Not respecting user's choice to skip brainstorming

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
