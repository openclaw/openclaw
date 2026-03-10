---
name: 'step-04-ux-alignment'
description: 'Check for UX document and validate alignment with PRD and Architecture'

nextStepFile: './step-05-epic-quality-review.md'
outputFile: '{planning_artifacts}/implementation-readiness-report-{{date}}.md'
---

# Step 4: UX Alignment

## STEP GOAL:

To check if UX documentation exists and validate that it aligns with PRD requirements and Architecture decisions, ensuring architecture accounts for both PRD and UX needs.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a UX VALIDATOR ensuring user experience is properly addressed
- ✅ UX requirements must be supported by architecture
- ✅ Missing UX documentation is a warning if UI is implied
- ✅ Alignment gaps must be documented

### Step-Specific Rules:

- 🎯 Check for UX document existence first
- 🚫 Don't assume UX is not needed
- 💬 Validate alignment between UX, PRD, and Architecture
- 🚪 Add findings to the output report

## EXECUTION PROTOCOLS:

- 🎯 Search for UX documentation
- 💾 If found, validate alignment
- 📖 If not found, assess if UX is implied
- 🚫 FORBIDDEN to proceed without completing assessment

## UX ALIGNMENT PROCESS:

### 1. Initialize UX Validation

"Beginning **UX Alignment** validation.

I will:

1. Check if UX documentation exists
2. If UX exists: validate alignment with PRD and Architecture
3. If no UX: determine if UX is implied and document warning"

### 2. Search for UX Documentation

Search patterns:

- `{planning_artifacts}/*ux*.md` (whole document)
- `{planning_artifacts}/*ux*/index.md` (sharded)
- Look for UI-related terms in other documents

### 3. If UX Document Exists

#### A. UX ↔ PRD Alignment

- Check UX requirements reflected in PRD
- Verify user journeys in UX match PRD use cases
- Identify UX requirements not in PRD

#### B. UX ↔ Architecture Alignment

- Verify architecture supports UX requirements
- Check performance needs (responsiveness, load times)
- Identify UI components not supported by architecture

### 4. If No UX Document

Assess if UX/UI is implied:

- Does PRD mention user interface?
- Are there web/mobile components implied?
- Is this a user-facing application?

If UX implied but missing: Add warning to report

### 5. Add Findings to Report

Append to {outputFile}:

```markdown
## UX Alignment Assessment

### UX Document Status

[Found/Not Found]

### Alignment Issues

[List any misalignments between UX, PRD, and Architecture]

### Warnings

[Any warnings about missing UX or architectural gaps]
```

### 6. Auto-Proceed to Next Step

After UX assessment complete, immediately load next step.

## PROCEEDING TO EPIC QUALITY REVIEW

UX alignment assessment complete. Loading next step for epic quality review.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- UX document existence checked
- Alignment validated if UX exists
- Warning issued if UX implied but missing
- Findings added to report

### ❌ SYSTEM FAILURE:

- Not checking for UX document
- Ignoring alignment issues
- Not documenting warnings
