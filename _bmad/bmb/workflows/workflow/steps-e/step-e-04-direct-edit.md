---
name: "step-e-04-direct-edit"
description: "Apply direct user-requested changes to workflow"

# File References
nextStepFile: "./step-e-05-apply-edit.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{workflow_name}.md"
targetWorkflowPath: "{targetWorkflowPath}"

# Standards References
architecture: "../data/architecture.md"
stepFileRules: "../data/step-file-rules.md"
frontmatterStandards: "../data/frontmatter-standards.md"
menuHandlingStandards: "../data/menu-handling-standards.md"
outputFormatStandards: "../data/output-format-standards.md"
stepTypePatterns: "../data/step-type-patterns.md"
workflowTypeCriteria: "../data/workflow-type-criteria.md"
inputDiscoveryStandards: "../data/input-discovery-standards.md"
csvDataFileStandards: "../data/csv-data-file-standards.md"
intentVsPrescriptive: "../data/intent-vs-prescriptive-spectrum.md"
---

# Edit Step 4: Direct Edit

## STEP GOAL:

Apply direct user-requested changes to the workflow, loading relevant standards and checking for non-compliance during editing.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER make changes without user approval
- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not an autonomous editor
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Focus on user-requested changes
- 🚫 FORBIDDEN to make changes without approval
- 💬 Check for non-compliance while editing
- 📋 Load relevant standards for each change type

## EXECUTION PROTOCOLS:

- 🎯 Work through each requested change
- 💾 Document each change in edit plan
- 📖 Load appropriate standards for each change type
- 🚫 IF non-compliance found: offer to fix before proceeding

## CONTEXT BOUNDARIES:

- Edit plan contains direct change goals
- Focus: Apply user's requested changes
- Must check for compliance issues during edits

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Read Edit Plan

**Load the editPlan:**
Read `{editPlan}` to review direct change goals from step 2.

### 2. For Each Direct Change Goal

**Work through each change systematically:**

#### A. Identify Change Type and Load Standards

**For workflow.md changes:**

- Load {architecture}

**For step file changes:**

- Load {stepFileRules}
- Load {stepTypePatterns}
- Load {intentVsPrescriptive}

**For frontmatter changes:**

- Load {frontmatterStandards}

**For menu changes:**

- Load {menuHandlingStandards}

**For output/template changes:**

- Load {outputFormatStandards}

**For data file changes:**

- Load {csvDataFileStandards}

**For workflow type changes:**

- Load {workflowTypeCriteria}

**For discovery/input changes:**

- Load {inputDiscoveryStandards}

#### B. Load Target File and Check Compliance

**Load the file to be edited and review against standards:**

"**Loading: {filename}**
**Standard: {standard file loaded}**

**Checking file against standards before making your change...**"

**IF NON-COMPLIANCE FOUND:**

"**⚠️ Compliance Issue Detected**

Before I apply your change, I noticed this file is not fully compliant with {standard}:

**Issue:** {describe the non-compliance}

**This could cause:** {explain impact}

**Should I fix this compliance issue before applying your change?**

1. **[F]ix first** - Fix compliance, then apply your change
2. **[C]ontinue anyway** - Apply your change without fixing
3. **[E]xplain more** - More details about the issue

#### Menu Handling Logic:

- IF F: Fix compliance first, then proceed to apply change
- IF C: Document user accepted risk, proceed with change
- IF E: Provide more details, then redisplay menu
- IF Any other: help user, then redisplay menu"

**IF COMPLIANT:**

"**File is compliant.** Proceeding with your change."

#### C. Present Current State and Proposed Change

"**Current state of: {filename}**

{show relevant section}

**Your requested change:**
{summarize the change from edit plan}

**Proposed modification:**
{show how the change will be made}

**Should I apply this change?**"

Wait for user approval.

#### D. Apply Change (If Approved)

**Load the file, make the change:**

```markdown
**Applying change to: {filename}**

**Before:**
{show relevant section}

**After:**
{show modified section}

**Change applied.** ✅"
```

**Update editPlan:**

```markdown
### Direct Changes Applied

**[{change type}]** {filename}

- ✅ Changed: {description}
- User approved: Yes
- Compliance check: Passed/Fixed/Accepted risk
```

### 3. Handle Common Change Patterns

#### Adding a New Step

1. Load {stepFileRules}, {stepTypePatterns}, {intentVsPrescriptive}
2. Check existing step numbering
3. Determine appropriate step type
4. Create step file with proper structure
5. Update nextStepFile references in adjacent steps
6. Verify menu handling compliance

#### Removing a Step

1. Load {architecture}
2. Check if step is referenced by other steps
3. Update nextStepFile in previous step
4. Confirm with user about impact
5. Remove step file
6. Verify no broken references

#### Modifying workflow.md

1. Load {architecture}
2. Check for progressive disclosure compliance (no step listings!)
3. Update goal/role/routing as requested
4. Ensure last section is routing
5. Verify frontmatter completeness

#### Adding/Modifying Data Files

1. Load {csvDataFileStandards}
2. Check file size (warn if >500 lines)
3. Verify CSV format if applicable
4. Ensure proper headers
5. Update step frontmatter references

#### Adding/Modifying Templates

1. Load {outputFormatStandards}
2. Determine template type
3. Ensure variable consistency
4. Update step frontmatter references

### 4. After All Changes Complete

**Present summary:**

"**Direct Edit Summary:**

**Total Changes Requested:** {count}
**Applied:** {count}
**Skipped:** {count}
**Modified:** {count}

**Compliance Issues Found During Editing:** {count}

- Fixed: {count}
- User accepted risk: {count}

**Files Modified:**

- {file1}
- {file2}
- etc."

### 5. Present MENU OPTIONS

Display: "**Direct Edits Applied. Select an Option:** [C] Continue"

#### Menu Handling Logic:

- IF C: Update editPlan stepsCompleted, then load, read entirely, then execute {nextStepFile}
- IF Any other: help user respond, then redisplay menu

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN all direct changes are applied (or documented) and user confirms, will you then load and read fully `{nextStepFile}` to execute.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All requested changes presented to user
- Relevant standards loaded for each change
- Compliance checked before each change
- User approval obtained for each change
- Non-compliance found and offered fix
- Changes applied correctly
- Edit plan updated

### ❌ SYSTEM FAILURE:

- Not loading relevant standards
- Not checking compliance before editing
- Making changes without user approval
- Missing non-compliance issues
- Not documenting changes

**Master Rule:** Load standards for each change type. Check compliance BEFORE applying changes. Offer to fix non-compliance when found.
