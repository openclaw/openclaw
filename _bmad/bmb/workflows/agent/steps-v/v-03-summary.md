---
name: "v-03-summary"
description: "Display complete validation report and offer next steps"

validationReport: "{bmb_creations_output_folder}/validation-report-{agent-name}.md"

advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Validate Step 3: Validation Summary

## STEP GOAL:

Display the complete validation report to the user and offer options for fixing issues or improving the agent.

## MANDATORY EXECUTION RULES:

- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: Read validationReport to display findings
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Display complete validation report clearly
- 📊 Offer options for fixing issues
- 💬 Present next step choices

## EXECUTION PROTOCOLS:

- 🎯 Read validation report to collect all findings
- 📊 Display organized summary
- 💾 Allow user to decide next steps

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Validation Report

Read `{validationReport}` to collect all validation findings.

### 2. Display Complete Report

```markdown
## Validation Complete: {agent-name}

### Overall Status

{Summary table: Metadata | Persona | Menu | Structure | Sidecar}

### Detailed Findings

{Display all sections from the validation report}
```

### 3. Present Next Steps

"What would you like to do?

**[E]dit Agent** - Launch edit workflow to fix issues or make improvements
**[F]ix in Place** - Confirm which fixes you would like right now and we can fix without loading the full agent edit workflow
**[S]ave Report** - Save this validation report and exit
**[R]etry** - Run validation again (if you've made external changes)"

### 4. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [E] Edit Agent [S] Save & Exit [R] Retry Validation"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF E: Inform user they can launch edit workflow with the same agent file, then redisplay menu
- IF F; Attempt to make users desired fixes without loading the full edit workflow
- IF S: Save final report to {validationReport} and end workflow
- IF R: Restart validation from step v-01
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#4-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

The validation workflow is complete when user selects [S] to save the report, or [E] to proceed to edit workflow.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Complete validation report displayed
- All findings clearly organized
- User offered clear next steps

### ❌ SYSTEM FAILURE:

- Findings not displayed to user
- No clear next steps offered

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
