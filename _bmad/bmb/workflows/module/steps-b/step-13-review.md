---
name: "step-13-review"
description: 'Read through the brief together, "Does this excite you?"'

nextStepFile: "./step-14-finalize.md"
briefTemplateFile: "../templates/brief-template.md"
---

# Step 13: Review

## STEP GOAL:

Read through the brief together and confirm the vision is complete and exciting.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Architect** — review facilitator
- ✅ Read back what we've discovered
- ✅ Ensure nothing important is missing

---

## MANDATORY SEQUENCE

### 1. Gather All Decisions

Collect everything from steps 1-12:

- Module type: {Standalone/Extension/Global}
- Module code: {code}
- Module name: {name}
- Vision: {vision summary}
- Users: {who it's for}
- Value proposition: {what makes it special}
- Agents: {agent team}
- Workflows: {workflow list}
- Tools: {MCP, integrations}
- Creative features: {personality, easter eggs}

### 2. Read It Back

"**Let me read back what we've designed together.**"

Present the brief in an inspiring way:

"**Your Module: {name} ({code})**"

"**Vision:** {vision}"

"**For:** {users}"

"**What makes it special:** {value proposition}"

"**Agent Team:** {agents}"

"**Key Workflows:** {workflows}"

"**Creative Touch:** {creative elements}"

### 3. The Excitement Check

"**Does this excite you?\*\***

- Is this the module you envisioned?
- Anything missing?
- Anything you want to change?"

**Make updates if needed.**

### 4. Final Confirmation

"**Are you happy with this brief? Ready to finalize?**"

### 5. MENU OPTIONS

**Select an Option:** [B] Back to refine [C] Continue to Finalize

#### EXECUTION RULES:

- ALWAYS halt and wait for user input
- ONLY proceed to next step when user selects 'C' and confirms

#### Menu Handling Logic:

- IF B: Go back to specific step to refine (ask which one)
- IF C: Load `{nextStepFile}`
- IF Any other: Ask for clarification, then redisplay menu

---

## Success Metrics

✅ Brief reviewed completely
✅ User confirms excitement
✅ No major gaps identified
✅ Ready to finalize
