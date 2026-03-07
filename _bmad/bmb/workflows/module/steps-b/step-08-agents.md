---
name: "step-08-agents"
description: "Agent architecture — party mode simulation of interactions"

nextStepFile: "./step-09-workflows.md"
agentArchitectureFile: "../data/agent-architecture.md"
advancedElicitationTask: "../../../../core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "../../../../core/workflows/party-mode/workflow.md"
---

# Step 8: Agents

## STEP GOAL:

Design the agent architecture — who's on your team? Simulate how agents might interact.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Architect** — team designer
- ✅ Focus on high-level planning (role, workflows, name, style)
- ✅ Don't worry about YAML format — agent-builder handles that

### Step-Specific Rules:

- 🎯 Load `{agentArchitectureFile}` for guidance
- 🎯 Party mode is great here — simulate agent interactions
- 🚫 FORBIDDEN to design full agent specs (that's agent-builder's job)

---

## MANDATORY SEQUENCE

### 1. Single vs Multi-Agent

Load `{agentArchitectureFile}` and ask:

**"Could one expert agent handle this entire module, or do you need a team?"**

Reference:

- **Single agent** — simpler, focused domain
- **Multi-agent** — different expertise areas, broader domain
- **BMM example** — 9 agents for complete software development team

### 2. Design the Agent Team

For each agent, capture:

**Role:** What are they responsible for?
**Workflows:** Which workflows will they trigger?
**Name:** Human name (optional, for personality)
**Communication Style:** How do they talk?
**Memory:** Do they need to remember things over time? (hasSidecar)

Keep it high-level — don't design full agent specs!

### 3. Party Mode Simulation

**"Want to simulate how your agents might interact?"**

- IF yes: Execute `{partyModeWorkflow}` with different agent personas
- Let them "talk" to each other about a scenario
- This reveals how the team works together

### 4. Agent Menu Coordination

Explain the pattern:

- **Shared commands** — all agents have `[WS]` Workflow Status
- **Specialty commands** — each agent has unique commands
- **No overlap** — each command has one owner

"**What commands might each agent have?**"

### 5. MENU OPTIONS

**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue

- IF A: Execute `{advancedElicitationTask}`
- IF P: Execute `{partyModeWorkflow}` — great for agent interaction simulation
- IF C: Load `{nextStepFile}`
- IF Any other: Help, then redisplay

---

## Success Metrics

✅ Single vs multi-agent decided
✅ Agent roles defined
✅ Agent-workflow mappings clear
✅ Agent interactions explored (via party mode if used)
