---
name: "step-04-persona"
description: "Shape the agent personality through four-field persona system"

# File References
nextStepFile: "./step-05-commands-menu.md"
agentPlan: "{bmb_creations_output_folder}/agent-plan-{agent_name}.md"
personaProperties: ../data/persona-properties.md
principlesCrafting: ../data/principles-crafting.md
communicationPresets: ../data/communication-presets.csv

# Example Personas (for reference)
simpleExample: ../data/reference/without-sidecar/commit-poet.agent.yaml
expertExample: ../data/reference/with-sidecar/journal-keeper/journal-keeper.agent.yaml

# Task References
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# STEP GOAL

Develop a complete four-field persona that defines the agent's personality, expertise, communication approach, and guiding principles. This persona becomes the foundation for how the agent thinks, speaks, and makes decisions.

# MANDATORY EXECUTION RULES

**CRITICAL: Field Purity Enforcement**

- Each persona field has ONE specific purpose
- NO mixing concepts between fields
- NO overlapping responsibilities
- Every field must be distinct and non-redundant

**Output Requirements:**

- Produce structured YAML block ready for agent.yaml
- Follow principles-crafting guidance exactly
- First principle MUST be the "expert activator"
- All fields must be populated before proceeding

# EXECUTION PROTOCOLS

## Protocol 1: Load Reference Materials

Read and integrate:

- `personaProperties.md` - Field definitions and boundaries
- `principlesCrafting.md` - Principles composition guidance
- `communicationPresets.csv` - Style options and templates
- Reference examples for pattern recognition

## Protocol 2: Four-Field System Education

Explain each field clearly:

**1. Role (WHAT they do)**

- Professional identity and expertise domain
- Capabilities and knowledge areas
- NOT personality or communication style
- Pure functional definition

**2. Identity (WHO they are)**

- Character, personality, attitude
- Emotional intelligence and worldview
- NOT job description or communication format
- Pure personality definition

**3. Communication Style (HOW they speak)**

- Language patterns, tone, voice
- Formality, verbosity, linguistic preferences
- NOT expertise or personality traits
- Pure expression definition

**4. Principles (WHY they act)**

- Decision-making framework and values
- Behavioral constraints and priorities
- First principle = expert activator (core mission)
- Pure ethical/operational definition

## Protocol 3: Progressive Field Development

### 3.1 Role Development

- Define primary expertise domain
- Specify capabilities and knowledge areas
- Identify what makes them an "expert"
- Keep it functional, not personal

**Role Quality Checks:**

- Can I describe their job without personality?
- Would this fit in a job description?
- Is it purely about WHAT they do?

### 3.2 Identity Development

- Define personality type and character
- Establish emotional approach
- Set worldview and attitude
- Keep it personal, not functional

**Identity Quality Checks:**

- Can I describe their character without job title?
- Would this fit in a character profile?
- Is it purely about WHO they are?

### 3.3 Communication Style Development

- Review preset options from CSV
- Select or customize style pattern
- Define tone, formality, voice
- Set linguistic preferences

**Communication Quality Checks:**

- Can I describe their speech patterns without expertise?
- Is it purely about HOW they express themselves?
- Would this fit in a voice acting script?

### 3.4 Principles Development

Follow `principlesCrafting.md` guidance:

1. **Principle 1: Expert Activator** - Core mission and primary directive
2. **Principle 2-5: Decision Framework** - Values that guide choices
3. **Principle 6+: Behavioral Constraints** - Operational boundaries

**Principles Quality Checks:**

- Does first principle activate expertise immediately?
- Do principles create decision-making clarity?
- Would following these produce the desired behavior?

## Protocol 4: Structured YAML Generation

Output the four-field persona in this exact format:

```yaml
role: >
  [Single sentence defining expertise and capabilities]

identity: >
  [2-3 sentences describing personality and character]

communication_style: >
  [Specific patterns for tone, formality, and voice]

principles:
  - [Expert activator - core mission]
  - [Decision framework value 1]
  - [Decision framework value 2]
  - [Behavioral constraint 1]
  - [Behavioral constraint 2]
```

# CONTEXT BOUNDARIES

**Include in Persona:**

- Professional expertise and capabilities (role)
- Personality traits and character (identity)
- Language patterns and tone (communication)
- Decision-making values (principles)

**Exclude from Persona:**

- Technical skills (belongs in knowledge)
- Tool usage (belongs in commands)
- Workflow steps (belongs in orchestration)
- Data structures (belongs in implementation)

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

1. **LOAD** personaProperties.md and principlesCrafting.md
2. **EXPLAIN** four-field system with clear examples
3. **DEVELOP** Role - define expertise domain and capabilities
4. **DEVELOP** Identity - establish personality and character
5. **DEVELOP** Communication Style - select/customize style preset
6. **DEVELOP** Principles - craft 5-7 principles following guidance
7. **OUTPUT** structured YAML block for agent.yaml
8. **DOCUMENT** to agent-plan.md
9. **PRESENT** completion menu

## 9. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue"

### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save content to {agentPlan}, update frontmatter, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#9-present-menu-options)

### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [all four persona fields populated with DISTINCT content and field purity verified], will you then load and read fully `{nextStepFile}` to execute and begin command structure design.

---

# SUCCESS METRICS

**Completion Indicators:**

- Four distinct, non-overlapping persona fields
- First principle activates expert capabilities
- Communication style is specific and actionable
- YAML structure is valid and ready for agent.yaml
- User confirms persona accurately reflects vision

**Failure Indicators:**

- Role includes personality traits
- Identity includes job descriptions
- Communication includes expertise details
- Principles lack expert activator
- Fields overlap or repeat concepts
- User expresses confusion or disagreement
