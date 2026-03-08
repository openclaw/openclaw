---
name: "step-e-02-apply-edits"
description: "Apply modifications to the teaching workflow based on edit plan"

workflowPath: "../"
---

# Edit Step 2: Apply Edits

## STEP GOAL:

To apply the approved edits to the teach-me-testing workflow files while maintaining integrity and quality standards.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER edit without showing user the changes first
- 📖 CRITICAL: Read complete step file before action
- ✅ SPEAK OUTPUT In {communication_language}

### Role Reinforcement:

- ✅ You are a workflow architect applying modifications
- ✅ Collaborative edits with user approval

### Step-Specific Rules:

- 🎯 Focus on applying approved edits only
- 🚫 FORBIDDEN to make unapproved changes
- 💬 Show changes before applying

## EXECUTION PROTOCOLS:

- 🎯 Apply edits systematically
- 💾 Validate after each edit
- 📖 Document changes made

## MANDATORY SEQUENCE

### 1. Review Edit Plan

"**Applying approved edits to teach-me-testing workflow**

From step-e-01, we identified:
{Summarize edit plan from previous step}

Let me apply these changes systematically."

### 2. Apply Edits by Category

**For each file to be edited:**

1. Load the current file
2. Show the proposed changes (before/after)
3. Ask: "Apply this edit? [Y/N]"
4. If Y: Make the edit
5. If N: Skip this edit
6. Confirm edit applied successfully

### 3. Validate Edits

After all edits applied:

**Check:**

- Frontmatter still valid
- File references still correct
- Menu handling logic intact
- Step sequence maintained

"**Validation:**

All edits applied successfully:

- {list files modified}

Checking integrity:

- ✅ Frontmatter valid
- ✅ File references correct
- ✅ Menu logic intact
- ✅ Step sequence maintained"

### 4. Summary of Changes

"**Edit Summary:**

**Files Modified:** {count}
{List each file with changes made}

**Changes Applied:**
{Summarize what was changed}

**Workflow Status:** ✅ Edits complete, workflow intact

**Next:** You can run the workflow to test your changes, or run validation mode to check quality."

### 5. Completion

"**Edit Mode Complete!**

The teach-me-testing workflow has been updated.

**Modified files:**
{List paths to modified files}

**Recommended next steps:**

1. Run validation: `bmad run teach-me-testing -v`
2. Test the workflow: `bmad run teach-me-testing`
3. Make additional edits if needed"

**This is the final edit step - workflow ends here.**

---

## 🚨 SUCCESS METRICS

✅ Edits applied to approved files only, changes validated, workflow integrity maintained, user informed of modifications.

**Master Rule:** Show changes, get approval, apply edits, validate integrity.
