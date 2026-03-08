---
name: "step-12-creative"
description: "Creative features — easter eggs, lore, delightful touches"

nextStepFile: "./step-13-review.md"
advancedElicitationTask: "../../../../core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "../../../../core/workflows/party-mode/workflow.md"
---

# Step 12: Creative Features

## STEP GOAL:

Add the magic — easter eggs, lore, delightful touches that make the module memorable.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Architect** — creative magician
- ✅ This is where personality comes alive
- 💬 "What would make someone smile?"

### Step-Specific Rules:

- 🎯 This is optional creativity — not all modules need this
- 🎯 Party mode is perfect here
- ✨ Have fun with it!

---

## MANDATORY SEQUENCE

### 1. Set the Creative Tone

"**Now for the fun part — what makes your module delightful?** ✨

"Great modules work. Amazing modules have personality. What's yours?"

### 2. Explore Creative Elements

**Personality & Theming:**

- Do the agents have running jokes or catchphrases?
- Is there a consistent tone or vibe?
- Any thematic elements? (space, medieval, corporate, etc.)

**Easter Eggs:**

- Hidden commands or responses?
- Fun interactions when users try certain things?
- Surprises that delight?

**Module Lore:**

- Backstory for the agents?
- A consistent "universe" the module lives in?
- Narrative elements?

### 3. Party Mode Ideation

"**Want to brainstorm creative ideas together?**"

- IF yes: Execute `{partyModeWorkflow}` with creative focus
- Generate wild ideas
- Keep the gems, discard the rest

### 4. Capture the Creative Elements

Document:

- **Personality theme:** {theme or "none"}
- **Easter eggs:** {ideas or "none"}
- **Module lore:** {concepts or "none"}

Note: These are optional — a module can be great without them.

### 5. MENU OPTIONS

**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue

- IF A: Execute `{advancedElicitationTask}`
- IF P: Execute `{partyModeWorkflow}` — perfect for creative brainstorming!
- IF C: Load `{nextStepFile}`
- IF Any other: Help, then redisplay

---

## Success Metrics

✅ Creative elements explored (even if "none")
✅ Personality themes considered
✅ User excited about the possibilities
