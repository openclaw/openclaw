---
name: "step-e-06-validate-after"
description: "Run validation after edits and present results"

# File References
nextStepFile: "./step-e-07-complete.md"
fixStep: "./step-e-03-fix-validation.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{workflow_name}.md"
targetWorkflowPath: "{targetWorkflowPath}"
validationWorkflow: "../steps-v/step-01-validate.md"
validationReport: "{targetWorkflowPath}/validation-report-{workflow_name}.md"
---

# Edit Step 6: Validate After Edit

## STEP GOAL:

Run validation workflow after edits are complete, present results, and offer next steps.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not an autonomous editor
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Focus on running validation and presenting results
- 💬 Explain validation outcomes clearly
- 🚪 Route based on validation results

## EXECUTION PROTOCOLS:

- 🎯 Execute validation workflow
- 💾 Present results to user
- 📖 Offer next steps based on findings

## CONTEXT BOUNDARIES:

- Edits have been applied
- Focus: Verify quality after edits
- This is quality assurance step

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Read Edit Plan

**Load the editPlan:**
Read `{editPlan}` to understand what edits were applied.

### 2. Execute Validation Workflow

"**Running comprehensive validation on your edited workflow...**

**Target:** {targetWorkflowPath}
**Validation scope:** Full workflow compliance check

This may take a few moments..."

**Load, read entirely, then execute:** {validationWorkflow}

### 3. Review Validation Results

**After validation completes, load the validation report:**

Read `{validationReport}` and extract:

- Overall status
- Critical issues count
- Warning issues count
- New issues vs pre-existing issues

### 4. Present Validation Results

"**Validation Complete!**

**Overall Assessment:** [PASS/PARTIAL/FAIL]

**Summary:**
| Category | Before Edits | After Edits | Change |
|----------|--------------|-------------|--------|
| Critical Issues | {count} | {count} | {delta} |
| Warnings | {count} | {count} | {delta} |
| Compliance Score | {score} | {score} | {delta} |

---

**New Issues Found:** {count}
**Issues Fixed:** {count}
**Remaining Issues:** {count}

---

**What would you like to do?**"

### 5. Menu Options Based on Results

**IF NEW CRITICAL ISSUES FOUND:**

"**[F]ix new issues** - Return to fix-validation step to address new critical issues
**[R]eview report** - See detailed validation findings
**[C]omplete anyway** - Finish editing with remaining issues (not recommended)"

#### Menu Handling Logic:

- IF F: Load, read entirely, then execute {fixStep}
- IF R: Present detailed findings from validation report, then redisplay this menu
- IF C: Warn user, then if confirmed, load, read entirely, then execute {nextStepFile}
- IF Any other: help user, then redisplay menu

**IF NO NEW CRITICAL ISSUES (warnings OK):**

"**[R]eview report** - See detailed validation findings
**[C]omplete** - Finish editing - workflow looks good!
**[M]ore edits** - Make additional changes"

#### Menu Handling Logic (Issues Found):

- IF R: Present detailed findings from validation report, then redisplay this menu
- IF C: Load, read entirely, then execute {nextStepFile}
- IF M: Route to step-e-02-discover-edits.md
- IF Any other: help user, then redisplay menu

**IF FULL PASS (no issues):**

"**🎉 Excellent! Your workflow is fully compliant!**

**[C]omplete** - Finish editing
**[R]eview report** - See validation details
**[M]ore edits** - Make additional changes"

#### Menu Handling Logic (Full Pass):

- IF C: Load, read entirely, then execute {nextStepFile}
- IF R: Present validation summary, then redisplay this menu
- IF M: Route to step-e-02-discover-edits.md
- IF Any other: help user, then redisplay menu

### 6. Update Edit Plan

**Before routing to complete:**

Update editPlan frontmatter:

```yaml
completionDate: "{current-date}"
validationAfterEdit: complete
finalValidationStatus: { status from validation report }
remainingCriticalIssues: { count }
remainingWarnings: { count }
```

Document in editPlan:

```markdown
## Final Validation

**Validation Date:** {current-date}
**Status:** {status}
**Issues After Editing:**

- Critical: {count}
- Warnings: {count}

**Recommendation:** {if issues remain, suggest next steps}
```

## CRITICAL STEP COMPLETION NOTE

ALWAYS present validation results clearly. Route based on severity of findings. Update edit plan with final validation status before completing.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Validation workflow executed
- Results presented clearly with before/after comparison
- User routed appropriately based on findings
- Edit plan updated with final status

### ❌ SYSTEM FAILURE:

- Not running validation
- Not presenting results clearly
- Routing to complete with critical issues without warning
- Not updating edit plan

**Master Rule:** Always run validation after edits. Present clear before/after comparison. Warn user about remaining issues.
