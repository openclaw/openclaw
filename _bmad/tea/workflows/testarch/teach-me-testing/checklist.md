# Teach Me Testing - Quality Checklist

## Workflow Quality Standards

Use this checklist to validate the teaching workflow meets quality standards.

---

## Foundation Quality

- [ ] **workflow.md** exists with proper frontmatter
- [ ] Tri-modal routing logic present (Create/Edit/Validate)
- [ ] Configuration loading references correct module (TEA)
- [ ] First step path correct (`./steps-c/step-01-init.md`)
- [ ] Folder structure complete (steps-c/, steps-e/, steps-v/, data/, templates/)

---

## Template Quality

- [ ] **progress-template.yaml** has complete schema
- [ ] All 7 sessions defined with proper structure
- [ ] Session status tracking fields present (not-started/in-progress/completed)
- [ ] stepsCompleted array for continuation tracking
- [ ] **session-notes-template.md** has all required sections
- [ ] **certificate-template.md** includes all 7 sessions

---

## Step File Quality (CREATE mode)

### Initialization Steps

- [ ] **step-01-init.md** checks for existing progress file
- [ ] Continuation detection logic works correctly
- [ ] **step-01b-continue.md** loads progress and routes to session menu
- [ ] Progress dashboard displays completion status

### Assessment Step

- [ ] **step-02-assess.md** gathers role, experience, goals
- [ ] Validation for role (QA/Dev/Lead/VP)
- [ ] Validation for experience (beginner/intermediate/experienced)
- [ ] Assessment data written to progress file

### Session Menu Hub

- [ ] **step-03-session-menu.md** displays all 7 sessions
- [ ] Completion indicators shown (✓ completed, 🔄 in-progress, ⬜ not-started)
- [ ] Branching logic routes to selected session (1-7)
- [ ] Exit logic (X) routes to completion if all done, otherwise saves and exits

### Session Steps (1-7)

- [ ] Each session loads relevant TEA docs just-in-time
- [ ] Teaching content presented (mostly autonomous)
- [ ] Quiz validation with ≥70% threshold
- [ ] Session notes artifact generated
- [ ] Progress file updated (status, score, artifact path)
- [ ] Returns to session menu hub after completion

### Completion Step

- [ ] **step-05-completion.md** verifies all 7 sessions complete
- [ ] Certificate generated with accurate data
- [ ] Final progress file update (certificate_generated: true)
- [ ] Congratulations message shown

---

## Data File Quality

- [ ] **curriculum.yaml** defines all 7 sessions
- [ ] **role-paths.yaml** maps role customizations
- [ ] **session-content-map.yaml** references TEA docs/fragments/URLs correctly
- [ ] **quiz-questions.yaml** has questions for all sessions
- [ ] **tea-resources-index.yaml** has complete documentation index

---

## Content Quality

### TEA Documentation Integration

- [ ] Local file paths correct (`/docs/*.md`, `/src/testarch/knowledge/*.md`)
- [ ] Online URLs correct (<https://bmad-code-org.github.io/...>)
- [ ] GitHub fragment links correct
- [ ] Triple reference system (local + online + GitHub) implemented

### Role-Based Content

- [ ] QA examples present (practical testing focus)
- [ ] Dev examples present (integration/TDD focus)
- [ ] Lead examples present (architecture/patterns focus)
- [ ] VP examples present (strategy/metrics focus)

### Quiz Quality

- [ ] Questions test understanding, not memorization
- [ ] 3-5 questions per session
- [ ] Mix of difficulty levels
- [ ] Clear correct answers with explanations

---

## Error Handling

- [ ] Corrupted progress file detection
- [ ] Backup and recovery options
- [ ] Missing TEA docs fallback (Web-Browsing)
- [ ] Quiz failure recovery (review or continue)
- [ ] Session interruption handling (auto-save)

---

## User Experience

- [ ] Clear navigation instructions
- [ ] Progress visibility (completion percentage, next recommended)
- [ ] Auto-save after each session
- [ ] Resume capability works seamlessly
- [ ] Exit options clear at all decision points

---

## State Management

- [ ] stepsCompleted array updated correctly
- [ ] Session tracking accurate (status, dates, scores)
- [ ] Completion percentage calculated correctly
- [ ] Next recommended session logic works
- [ ] lastStep and lastContinued timestamps updated

---

## Validation Mode

- [ ] **step-v-01-validate.md** checks all quality standards
- [ ] Generates validation report
- [ ] Identifies issues clearly
- [ ] Provides remediation suggestions

---

## Edit Mode

- [ ] **step-e-01-assess-workflow.md** identifies what to edit
- [ ] **step-e-02-apply-edits.md** applies modifications safely
- [ ] Preserves workflow integrity during edits

---

## Documentation

- [ ] **instructions.md** clear and complete
- [ ] **checklist.md** (this file) comprehensive
- [ ] README (if present) accurate
- [ ] Inline comments in complex logic

---

## Performance

- [ ] Just-in-time loading (not loading all docs upfront)
- [ ] Session steps complete in reasonable time (<5 min)
- [ ] Quiz validation fast (<1 min)
- [ ] Progress file writes efficient

---

## Security

- [ ] No hardcoded credentials
- [ ] File paths use variables
- [ ] Progress files private to user
- [ ] No sensitive data in session notes

---

## Completion Criteria

✅ **Workflow is ready for deployment when:**

- All checkboxes above are checked
- All step files exist and follow standards
- All templates present and correct
- Data files complete and accurate
- Error handling robust
- User experience smooth
- Documentation complete

---

**Validation Date:** **\*\***\_\_\_**\*\***
**Validated By:** **\*\***\_\_\_**\*\***
**Issues Found:** **\*\***\_\_\_**\*\***
**Status:** ⬜ Ready for Production | ⬜ Needs Revisions
