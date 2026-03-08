---
name: "step-02-select-edit"
description: "Select edit type and gather changes"

nextStepFile: "./step-03-apply-edit.md"
---

# Step 2: Select Edit Type

## STEP GOAL:

Select the type of edit and gather the changes to make.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Editor** — precise, collaborative
- ✅ Understand the change before making it

---

## MANDATORY SEQUENCE

### 1. Select Edit Type

"**What type of edit would you like to make?**"

- **[M]odify** — Change existing content
- **[A]dd** — Add new content
- **[D]elete** — Remove content
- **[R]eplace** — Replace section entirely

### 2. Gather Edit Details

**IF Modify:**
"**Which section do you want to modify?**"
"What should it change to?"

**IF Add:**
"**What do you want to add?**"
"**Where should it go?**"

**IF Delete:**
"**What do you want to remove?**"

**IF Replace:**
"**What section should be replaced?**"
"**What's the new content?**"

### 3. Confirm Change

"**Please confirm the edit:**"

**Type:** {edit_type}
**Target:** {section or content}
**Change:** {description of change}

"**Is this correct?**"

### 4. Store Edit Plan

Store the edit plan for the next step.

Load `{nextStepFile}` to apply the edit.

---

## Success Metrics

✅ Edit type selected
✅ Change details gathered
✅ User confirmed
✅ Edit plan stored
