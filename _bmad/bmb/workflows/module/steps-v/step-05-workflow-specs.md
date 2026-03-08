---
name: "step-05-workflow-specs"
description: "Validate workflow specifications and built workflows"

nextStepFile: "./step-06-documentation.md"
workflowSpecTemplate: "../templates/workflow-spec-template.md"
workflowValidationWorkflow: "{project-root}/_bmad/bmb/workflows/workflow/steps-v/step-01-validate.md"
validationReportOutput: "{validation_report_output}"
targetPath: "{validation_target_path}"
---

# Step 5: Workflow Specs Validation

## STEP GOAL:

Validate workflow specifications and/or built workflows, distinguishing between placeholder specs and fully implemented workflows.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Quality Assurance** — dual-mode checking
- ✅ Specs are expected, built workflows are great
- ✅ Track status of each workflow

---

## MANDATORY SEQUENCE

### 1. Load Workflow Files

Find all workflow files in `{targetPath}/workflows/`:

- `.spec.md` files (placeholder specs)
- `workflow.md` files (built workflows)

### 2. Categorize Workflows

For each workflow found, determine status:

**Built Workflows (workflow.md with steps/ folder):**

- Full implementation with step files, data, templates
- Can be validated in-depth via workflow validation workflow

**Spec Workflows (.spec.md):**

- High-level placeholder/blueprint
- Awaiting creation via workflow-builder workflow

Track counts:

- Total workflows: {count}
- Built workflows: {count}
- Spec workflows: {count}

### 3. Validate Spec Workflows (.spec.md)

For each spec workflow, check:

**Required Sections:**

- [ ] Workflow goal defined
- [ ] Description present
- [ ] Workflow type indicated
- [ ] Step list or outline present
- [ ] Agent association clear

**Inputs/Outputs:**

- [ ] Input requirements documented
- [ ] Output format specified

**Agent Integration:**

- [ ] Primary agent identified
- [ ] Multi-agent collaboration noted (if applicable)

**Placeholder Note:** These are specs awaiting workflow-builder.

### 4. Validate Built Workflows (workflow.md)

For each built workflow, check:

**Workflow Structure:**

- [ ] workflow.md exists with proper frontmatter
- [ ] steps/ folder exists (steps-c/, steps-e/, steps-v/ as appropriate)
- [ ] Step files follow naming conventions

**Step File Compliance:**

- [ ] Each step has proper frontmatter
- [ ] Step files within size limits
- [ ] Menu handling follows standards

**Status:** These are complete implementations and can be validated in detail via sub-process.

### 5. Record Results

Append to `{validationReportOutput}`:

```markdown
## Workflow Specs Validation

**Status:** {PASS/FAIL/WARNINGS}

**Workflow Summary:**

- Total Workflows: {count}
- Built Workflows: {count} {list}
- Spec Workflows: {count} {list}

**Built Workflows:**
{for each built workflow}

- **{name}**: {status} - Ready for detailed validation via workflow workflow

**Spec Workflows:**
{for each spec workflow}

- **{name}**: {status} - Placeholder awaiting workflow-builder

**Issues Found:**
{list any issues}

**Recommendations:**
{if specs exist}

- Use `bmad:bmb:workflows:workflow` or `/workflow` to create {spec workflow names}
- After building workflows, re-run validation to verify compliance
  {endif}
```

### 6. Note Sub-Process Opportunity

**IF built workflows exist:**

"**The following built workflows can be validated in detail:**"

{list built workflows}

"**After this validation completes, I can spawn sub-processes to run the workflow validation workflow on each built workflow for deeper compliance checking.**"

### 7. Auto-Proceed

"**✓ Workflow specs check complete.**"

Proceeding to next validation...

Load `{nextStepFile}`

---

## Success Metrics

✅ All workflow files checked
✅ Status tracked (spec vs built)
✅ Agent associations validated
✅ Recommendations for specs documented
✅ Sub-process opportunity noted
