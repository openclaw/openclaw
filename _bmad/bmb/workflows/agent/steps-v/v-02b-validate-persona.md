---
name: "v-02b-validate-persona"
description: "Validate persona and append to report"

nextStepFile: "./v-02c-validate-menu.md"
validationReport: "{bmb_creations_output_folder}/validation-report-{agent-name}.md"
personaProperties: ../data/persona-properties.md
principlesCrafting: ../data/principles-crafting.md
agentFile: "{agent-file-path}"
---

# Validate Step 2b: Validate Persona

## STEP GOAL

Validate the agent's persona against BMAD standards as defined in personaProperties.md and principlesCrafting.md. Append findings to validation report and auto-advance.

## MANDATORY EXECUTION RULES

- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: Read validationReport and persona references first
- 🔄 CRITICAL: Load the actual agent file to validate persona
- 🚫 NO MENU - append findings and auto-advance
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Validate persona against personaProperties.md rules
- 📊 Append findings to validation report
- 🚫 FORBIDDEN to present menu

## EXECUTION PROTOCOLS

- 🎯 Load personaProperties.md and principlesCrafting.md
- 🎯 Load the actual agent file for validation
- 📊 Validate persona fields
- 💾 Append findings to validation report
- ➡️ Auto-advance to next validation step

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load References

Read `{personaProperties}`, `{principlesCrafting}`, `{validationReport}`, and `{agentFile}`.

### 2. Validate Persona

Perform these checks systematically - validate EVERY rule specified in personaProperties.md:

1. **Required Fields Existence**
   - [ ] role: Present, clear, and specific
   - [ ] identity: Present and defines who the agent is
   - [ ] communication_style: Present and appropriate to role
   - [ ] principles: Present as array, not empty (if applicable)

2. **Content Quality - Role**
   - [ ] Role is specific (not generic like "assistant")
   - [ ] Role aligns with agent's purpose and menu items
   - [ ] Role is achievable within LLM capabilities
   - [ ] Role scope is appropriate (not too broad/narrow)

3. **Content Quality - Identity**
   - [ ] Identity clearly defines the agent's character
   - [ ] Identity is consistent with the role
   - [ ] Identity provides context for behavior
   - [ ] Identity is not generic or cliché

4. **Content Quality - Communication Style**
   - [ ] Communication style is clearly defined
   - [ ] Style matches the role and target users
   - [ ] Style is consistent throughout the definition
   - [ ] Style examples or guidance provided if nuanced
   - [ ] Style focuses on speech patterns only (not behavior)

5. **Content Quality - Principles**
   - [ ] Principles are actionable (not vague platitudes)
   - [ ] Principles guide behavior and decisions
   - [ ] Principles are consistent with role
   - [ ] 3-7 principles recommended (not overwhelming)
   - [ ] Each principle is clear and specific
   - [ ] First principle activates domain knowledge

6. **Consistency Checks**
   - [ ] Role, identity, communication_style, principles all align
   - [ ] No contradictions between principles
   - [ ] Persona supports the menu items defined
   - [ ] Language and terminology consistent

### 3. Append Findings to Report

Append to `{validationReport}`:

```markdown
### Persona Validation

**Status:** {✅ PASS / ⚠️ WARNING / ❌ FAIL}

**Checks:**

- [ ] role: specific, not generic
- [ ] identity: defines who agent is
- [ ] communication_style: speech patterns only
- [ ] principles: first principle activates domain knowledge

**Detailed Findings:**

_PASSING:_
{List of passing checks}

_WARNINGS:_
{List of non-blocking issues}

_FAILURES:_
{List of blocking issues that must be fixed}
```

### 4. Auto-Advance

Load and execute `{nextStepFile}` immediately.

---

**Validating menu structure...**
