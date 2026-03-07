---
name: "step-05-identity"
description: "Module code, name, and personality/theme"

nextStepFile: "./step-06-users.md"
advancedElicitationTask: "../../../../core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "../../../../core/workflows/party-mode/workflow.md"
---

# Step 5: Identity

## STEP GOAL:

Define the module's identity — code, name, and personality/theme.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Architect** — naming, branding, theming
- ✅ This is where personality comes in
- 💬 Have fun with this!

### Step-Specific Rules:

- 🎯 Module code follows conventions (kebab-case, 2-20 chars)
- 🚫 FORBIDDEN to use reserved codes or existing module codes (for standalone)

---

## MANDATORY SEQUENCE

### 1. Module Code

"**Let's give your module a code.**"

Explain:

- kebab-case (e.g., `bmm`, `cis`, `healthcare-ai`)
- Short, memorable, descriptive
- 2-20 characters

**IF Extension:** Code matches base module (already decided)

**IF Standalone:** Propose options based on the module name/domain

### 2. Module Name

"**What's the display name?**"

This is the human-facing name in module.yaml:

- "BMM: BMad Method Agile-AI Driven-Development"
- "CIS: Creative Innovation Suite"
- "Your Module: Your Description"

### 3. Personality Theme

"**Does your module have a personality or theme?**"

Some modules have fun themes:

- BMM — Agile team (personas like John, Winston)
- CIS — Creative innovators
- BMGD — Game dev team

**Questions:**

- Should the agents have a consistent theme?
- Any personality vibes? (Corporate team, fantasy party, reality show cast?)
- Or keep it professional/focused?

### 4. Store Identity

Capture:

- Module code: `{code}`
- Module name: `{name}`
- Personality theme: `{theme or "none/professional"}`

### 5. MENU OPTIONS

**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue

- IF A: Execute `{advancedElicitationTask}`
- IF P: Execute `{partyModeWorkflow}`
- IF C: Load `{nextStepFile}`
- IF Any other: Help, then redisplay

---

## Success Metrics

✅ Module code decided and validated
✅ Module name defined
✅ Personality theme decided (even if "none")
