---
name: "step-08-report"
description: "Generate final validation report"

validationReportOutput: "{validation_report_output}"
agentValidationWorkflow: "{project-root}/_bmad/bmb/workflows/agent/steps-v/step-01-validate.md"
workflowValidationWorkflow: "{project-root}/_bmad/bmb/workflows/workflow/steps-v/step-01-validate.md"
---

# Step 8: Validation Report

## STEP GOAL:

Compile all validation results into a final report with actionable recommendations, including sub-process validation opportunities for built agents and workflows.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Quality Assurance** — reporting results
- ✅ Clear, actionable feedback
- ✅ Sub-process validation for built components

---

## MANDATORY SEQUENCE

### 1. Compile Overall Status

Review all validation sections and determine overall status:

**PASS:** All checks passed, ready to proceed
**WARNINGS:** Minor issues found, can proceed with fixes
**FAIL:** Critical issues found, must fix before proceeding

### 2. Generate Summary

Add to `{validationReportOutput}`:

```markdown
---

## Overall Summary

**Status:** {PASS/WARNINGS/FAIL}

**Breakdown:**
- File Structure: {status}
- module.yaml: {status}
- Agent Specs: {status} ({built_count} built, {spec_count} specs)
- Workflow Specs: {status} ({built_count} built, {spec_count} specs)
- Documentation: {status}
- Installation Readiness: {status}

---

## Component Status

### Agents

- **Built Agents:** {count} — {list}
- **Spec Agents:** {count} — {list}

### Workflows

- **Built Workflows:** {count} — {list}
- **Spec Workflows:** {count} — {list}

---

## Recommendations

{priority-listed-recommendations}

### Priority 1 - Critical (must fix)

{critical_issues}

### Priority 2 - High (should fix)

{high_priority_issues}

### Priority 3 - Medium (nice to have)

{medium_priority_issues}

---

## Sub-Process Validation

{if built_agents_exist}

### Built Agent Deep Validation

The following built agents can be validated in detail using the agent validation workflow:

{for each built_agent}

- **{agent_name}** — Use `{agentValidationWorkflow}`

**Recommendation:** Run agent validation workflow on each built agent to verify:

- Frontmatter completeness
- Persona quality
- Menu structure compliance
- Sidecar validation

**After fixing any module-level issues, I can spawn sub-processes to validate each built agent in parallel.**
{endif}

{if built_workflows_exist}

### Built Workflow Deep Validation

The following built workflows can be validated in detail using the workflow validation workflow:

{for each built_workflow}

- **{workflow_name}** — Use `{workflowValidationWorkflow}`

**Recommendation:** Run workflow validation workflow on each built workflow to verify:

- Step file compliance
- Tri-modal structure (steps-c/steps-e/steps-v/)
- Frontmatter completeness
- Size limits compliance

**After fixing any module-level issues, I can spawn sub-processes to validate each built workflow in parallel.**
{endif}

---

## Next Steps

{based_on_status}

{if specs_exist}

### Build Spec Components

**Spec Agents:** {spec_count}

- Use `bmad:bmb:agents:agent-builder` to create: {spec_agent_names}

**Spec Workflows:** {spec_count}

- Use `bmad:bmb:workflows:workflow` to create: {spec_workflow_names}

**After building specs, re-run validation to verify compliance.**
{endif}

---

**Validation Completed:** {timestamp}
```

### 3. Present Report

"**✓ Validation complete!**"

**Overall Status:** {overall_status}

**Report saved to:** `{validationReportOutput}`

{if built_components_exist}
"**Built components found:**"

- Built Agents: {count}
- Built Workflows: {count}

"**These can be validated in depth via sub-process.**"
{endif}

### 4. Offer Next Actions

"**What would you like to do?**"

- **[R]ead report** — Show the full validation report
- **[S]ub-process validation** — Run deep validation on built agents/workflows
- **[F]ix issues** — Edit mode to fix identified problems
- **[D]one** — Complete validation

### 5. Menu Handling

- IF R: Display the full report
- IF S:
  - {if built_components_exist}
  - Offer to run agent validation on built agents
  - Offer to run workflow validation on built workflows
  - Can run in parallel for efficiency
  - {else}
  - "No built components found for sub-process validation."
  - {endif}
- IF F: Offer to load Edit mode
- IF D: Complete validation session

---

## Success Metrics

✅ Overall status determined
✅ Complete report generated
✅ Actionable recommendations provided
✅ Sub-process validation opportunities identified
✅ Next steps offered
