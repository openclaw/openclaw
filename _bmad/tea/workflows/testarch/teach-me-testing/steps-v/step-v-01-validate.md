---
name: "step-v-01-validate"
description: "Validate teach-me-testing workflow quality against BMAD standards"

workflowPath: "../"
checklistFile: "../checklist.md"
validationReport: "{test_artifacts}/workflow-validation/teach-me-testing-validation-{date}.md"
---

# Validate Step 1: Quality Validation

## STEP GOAL:

To systematically validate the teach-me-testing workflow against BMAD quality standards and generate a comprehensive validation report.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER skip validation checks
- 📖 CRITICAL: Read complete step file before action
- ✅ SPEAK OUTPUT In {communication_language}

### Role Reinforcement:

- ✅ You are a workflow quality assurance specialist
- ✅ Systematic validation against standards

### Step-Specific Rules:

- 🎯 Focus on comprehensive validation
- 🚫 FORBIDDEN to skip any checks
- 💬 Report findings clearly

## EXECUTION PROTOCOLS:

- 🎯 Run all validation checks
- 💾 Generate validation report
- 📖 Provide remediation guidance

## MANDATORY SEQUENCE

### 1. Validation Start

"**Validating Workflow: teach-me-testing**

Running comprehensive quality checks against BMAD standards...

This will validate:

- Foundation structure
- Step file quality (12 CREATE, 2 EDIT, 1 VALIDATE)
- Template quality
- Data file completeness
- Frontmatter compliance
- Menu handling patterns
- State management
- Documentation

**Starting validation...**"

### 2. Foundation Structure Validation

**Check:**

- [ ] workflow.md exists with proper frontmatter
- [ ] Tri-modal routing logic present
- [ ] Configuration loading correct
- [ ] First step path correct
- [ ] Folder structure complete (steps-c/, steps-e/, steps-v/, data/, templates/)

Report findings: Pass/Fail for each check.

### 3. Template Validation

**Check templates/:**

- [ ] progress-template.yaml has complete schema
- [ ] All 7 sessions defined
- [ ] Session status fields present
- [ ] stepsCompleted array present
- [ ] session-notes-template.md has required sections
- [ ] certificate-template.md includes all 7 sessions

Report findings.

### 4. Step File Validation (CREATE Mode)

**For each of 12 steps in steps-c/:**

- [ ] Frontmatter valid (name, description present)
- [ ] All frontmatter variables used in body
- [ ] File references use relative paths correctly
- [ ] Menu handling follows standards
- [ ] Step goal clearly stated
- [ ] MANDATORY SEQUENCE present
- [ ] Success/failure metrics present
- [ ] File size reasonable (<250 lines recommended)

Report findings per step.

### 5. Data File Validation

**Check data/:**

- [ ] curriculum.yaml defines all 7 sessions
- [ ] role-paths.yaml has all 4 roles (QA/Dev/Lead/VP)
- [ ] session-content-map.yaml maps sessions to resources
- [ ] quiz-questions.yaml has questions for sessions 1-6
- [ ] tea-resources-index.yaml has complete documentation index

Report findings.

### 6. Content Quality Validation

**Check session steps:**

- [ ] Teaching content present and comprehensive
- [ ] Role-adapted examples present
- [ ] Quiz questions validate understanding
- [ ] TEA resource references correct
- [ ] Knowledge fragment references accurate
- [ ] Online URLs functional

Report findings.

### 7. State Management Validation

**Check continuable workflow features:**

- [ ] step-01-init checks for existing progress
- [ ] step-01b-continue loads and displays progress
- [ ] All session steps update stepsCompleted array
- [ ] Progress file schema matches template
- [ ] Session menu reads progress correctly
- [ ] Completion step verifies all sessions done

Report findings.

### 8. User Experience Validation

**Check UX:**

- [ ] Clear navigation instructions
- [ ] Progress visibility (percentage, indicators)
- [ ] Auto-save after sessions
- [ ] Resume capability
- [ ] Exit options clear
- [ ] Session descriptions helpful

Report findings.

### 9. Generate Validation Report

Create {validationReport}:

```markdown
---
workflow: teach-me-testing
validation_date: { current_date }
validator: TEA Validation Workflow
overall_status: PASS / FAIL / PASS_WITH_WARNINGS
---

# Teach Me Testing - Validation Report

**Date:** {current_date}
**Workflow Version:** 1.0.0
**Overall Status:** {status}

---

## Validation Summary

**Total Checks:** {count}
**Passed:** {pass_count}
**Failed:** {fail_count}
**Warnings:** {warning_count}

**Overall Quality Score:** {score}/100

---

## Foundation Structure

{Report findings}

## Template Quality

{Report findings}

## Step File Quality

{Report findings for all 15 steps}

## Data File Quality

{Report findings}

## Content Quality

{Report findings}

## State Management

{Report findings}

## User Experience

{Report findings}

---

## Issues Found

{List all failures and warnings}

---

## Remediation Recommendations

{For each issue, provide fix guidance}

---

## Conclusion

{Overall assessment}

**Status:** {READY_FOR_PRODUCTION / NEEDS_FIXES / PASS_WITH_MINOR_ISSUES}
```

### 10. Display Results

"**Validation Complete!**

**Overall Status:** {status}
**Quality Score:** {score}/100

**Report saved:** {validationReport}

{If PASS:}
✅ **Workflow is ready for production!**

{If FAIL:}
❌ **Issues found that need fixing.**
See report for details: {validationReport}

{If WARNINGS:}
⚠️ **Minor issues found.**
Workflow is usable but could be improved.

**Validation report generated.**"

**This is the final validation step - workflow ends here.**

---

## 🚨 SUCCESS METRICS

✅ All validation checks run, comprehensive report generated, issues identified with remediation guidance, overall status determined.

**Master Rule:** Check everything systematically, report findings clearly, provide actionable remediation.
