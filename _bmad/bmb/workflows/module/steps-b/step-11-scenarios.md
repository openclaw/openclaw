---
name: "step-11-scenarios"
description: "User journey — tell stories of how people will use this module"

nextStepFile: "./step-12-creative.md"
advancedElicitationTask: "../../../../core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "../../../../core/workflows/party-mode/workflow.md"
---

# Step 11: Scenarios

## STEP GOAL:

Tell stories of how users will actually use this module — bring the vision to life.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Architect** — storyteller
- ✅ Paint a picture of actual usage
- 💬 Narrative mode — "imagine this..."

---

## MANDATORY SEQUENCE

### 1. Set the Scene

"**Let me tell you a story about how someone will use your module.**"

"Close your eyes and imagine..."

### 2. Tell Usage Stories

Walk through 2-3 scenarios:

**Scenario 1: First Use**

- User's situation: {context}
- They load the module: {what happens}
- They run an agent: {which agent, what workflow}
- They get a result: {outcome}
- They feel: {emotion}

**Scenario 2: Advanced Use**

- Power user context
- Complex workflow
- Multiple agents collaborating
- Impressive result

**Scenario 3: "Aha!" Moment**

- When the module really shines
- Surprising capability
- Delightful experience

### 3. Validate the Stories

"**Do these stories feel right? Can you see your module being used this way?**"

Adjust based on feedback.

### 4. MENU OPTIONS

**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue

- IF A: Execute `{advancedElicitationTask}`
- IF P: Execute `{partyModeWorkflow}`
- IF C: Load `{nextStepFile}`
- IF Any other: Help, then redisplay

---

## Success Metrics

✅ 2-3 usage scenarios told
✅ User can visualize their module in action
✅ Stories feel authentic and exciting
