---
name: "step-e-03-fix-validation"
description: "Systematically fix validation issues from validation report"

# File References
nextStepFile: "./step-e-05-apply-edit.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{workflow_name}.md"
targetWorkflowPath: "{targetWorkflowPath}"
validationReport: "{targetWorkflowPath}/validation-report-{workflow_name}.md"

# Standards References
architecture: "../data/architecture.md"
stepFileRules: "../data/step-file-rules.md"
frontmatterStandards: "../data/frontmatter-standards.md"
menuHandlingStandards: "../data/menu-handling-standards.md"
outputFormatStandards: "../data/output-format-standards.md"
stepTypePatterns: "../data/step-type-patterns.md"
---

# Edit Step 3: Fix Validation Issues

## STEP GOAL:

Systematically fix all issues identified in the validation report, working through each issue with user approval and loading relevant standards.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER make changes without user approval
- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not an autonomous editor
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Focus on fixing validation issues systematically
- 🚫 FORBIDDEN to skip issues or fix without approval
- 💬 Explain each issue and proposed fix
- 📋 Load relevant standards for each fix type

## EXECUTION PROTOCOLS:

- 🎯 Work through issues systematically
- 💾 Document each fix in edit plan
- 📖 Load appropriate standards for each issue type
- 🚫 FORBIDDEN to proceed without user approval for each fix

## CONTEXT BOUNDARIES:

- Validation report provides list of issues
- Edit plan documents fix goals
- Focus: Fix each issue with standards adherence
- This is systematic remediation, not creative editing

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Read Context Files

**Load these files first:**

1. `{editPlan}` - Review fix goals
2. `{validationReport}` - Get full list of issues

### 2. Organize Issues by Type

**From validation report, categorize issues:**

| Issue Type             | Standard File           | Count |
| ---------------------- | ----------------------- | ----- |
| workflow.md violations | {architecture}          |       |
| Step file structure    | {stepFileRules}         |       |
| Frontmatter issues     | {frontmatterStandards}  |       |
| Menu handling          | {menuHandlingStandards} |       |
| Output format          | {outputFormatStandards} |       |
| Step type issues       | {stepTypePatterns}      |       |

### 3. Work Through Issues Systematically

**For EACH issue in order of severity (Critical → Warning):**

#### A. Load Relevant Standard

**Before proposing fix, load the relevant standard file:**

- If workflow.md issue → Load {architecture}
- If step file issue → Load {stepFileRules}
- If frontmatter issue → Load {frontmatterStandards}
- If menu issue → Load {menuHandlingStandards}
- If output issue → Load {outputFormatStandards}
- If step type issue → Load {stepTypePatterns}

#### B. Explain the Issue

"**Issue: [{issue type}] {file}:{location if applicable}**

**What the validation found:**
{Quote the validation finding}

**Why this is a problem:**
{Explain the impact based on the standard}

**Standard reference:**
{Cite the specific standard from the loaded file}"

#### C. Propose Fix

"**Proposed fix:**
{Specific change needed}

**This will:**

- ✅ Fix the compliance issue
- ✅ Align with: {specific standard}
- ⚠️ Potential impact: {any side effects}

**Should I apply this fix?**"

#### D. Get User Approval

Wait for user response:

- **Yes/Y** - Apply the fix
- **No/N** - Skip this issue (document why)
- **Modify** - User suggests alternative approach
- **Explain** - Provide more detail

#### E. Apply Fix (If Approved)

**Load the target file, make the change:**

```markdown
**Applying fix to: {file}**

**Before:**
{show relevant section}

**After:**
{show modified section}

**Fix applied.** ✅"
```

**Update editPlan:**

```markdown
### Fixes Applied

**[{issue type}]** {file}

- ✅ Fixed: {description}
- Standard: {standard reference}
- User approved: Yes
```

### 4. Handle Skip/Modify Responses

**IF user skips an issue:**

"**Issue skipped.**

Documenting in edit plan:

- [{issue type}] {file} - SKIPPED per user request
- Reason: {user's reason if provided}

**Note:** This issue will remain in the validation report.

Continue to next issue?"

**IF user wants to modify the fix:**

Discuss alternative approach, get agreement, then apply modified fix.

### 5. After All Issues Complete

**Present summary:**

"**Validation Fix Summary:**

**Total Issues Found:** {count}
**Fixed:** {count}
**Skipped:** {count}
**Modified:** {count}

**Remaining Issues:** {list any skipped or remaining warnings}

**Files Modified:**

- {file1}
- {file2}
- etc."

### 6. Check for Direct Edit Goals

**Load editPlan and check:**

**IF edit plan includes direct change goals (beyond validation fixes):**

"Your edit plan also includes direct changes. After we apply these validation fixes, we'll proceed to those changes."

Update editPlan frontmatter:

```yaml
validationFixesComplete: true
```

Then route to {nextStepFile} for direct edits.

**ELSE (no direct changes - validation fixes only):**

"Validation fixes are complete! Would you like to:

1. **[R]e-run validation** - Verify all fixes are working
2. **[C]omplete** - Finish editing with these fixes
3. **[M]ake additional changes** - Add more edits"

#### Menu Handling Logic:

- IF R: Run validation workflow, then return to this step
- IF C: Route to step-e-07-complete.md
- IF M: Route to step-e-02-discover-edits.md
- IF Any other: help user, then redisplay menu

### 7. Present MENU OPTIONS (If Proceeding)

Display: "**Validation Fixes Applied. Select an Option:** [C] Continue"

#### Menu Handling Logic:

- IF C: Update editPlan stepsCompleted, then load, read entirely, then execute appropriate next step
- IF Any other: help user respond, then redisplay menu

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN all validation issues are addressed (fixed, skipped, or documented) and user confirms, will you then route to the appropriate next step.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All issues presented to user systematically
- Relevant standards loaded for each issue
- User approval obtained for each fix
- Fixes applied correctly
- Edit plan updated with all changes
- Files properly modified

### ❌ SYSTEM FAILURE:

- Skipping issues without user approval
- Not loading relevant standards
- Making changes without user confirmation
- Not documenting fixes in edit plan
- Applying fixes incorrectly

**Master Rule:** Work through issues systematically. Load standards for each issue type. Get explicit approval before applying any fix.
