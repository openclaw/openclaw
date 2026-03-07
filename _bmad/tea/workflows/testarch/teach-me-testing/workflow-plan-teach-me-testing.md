---
stepsCompleted:
  [
    "step-01-discovery",
    "step-02-classification",
    "step-03-requirements",
    "step-04-tools",
    "step-05-plan-review",
    "step-06-design",
    "step-07-foundation",
  ]
created: 2026-01-27
status: FOUNDATION_COMPLETE
approvedDate: 2026-01-27
designCompletedDate: 2026-01-27
foundationCompletedDate: 2026-01-28
---

# Workflow Creation Plan

## Discovery Notes

**User's Vision:**
Create an ongoing learning companion that teaches testing progressively through a structured curriculum. Users at the company (and beyond) lack testing knowledge regardless of experience level - from hobbyist beginners to experienced VPs. The TEA (Test Architecture Enterprise) module has extensive documentation (~24k lines, 200 files, 9 workflows, 35 knowledge fragments), but manual teaching doesn't scale. This workflow solves that by providing self-paced, structured learning with state persistence across multiple sessions.

**Who It's For:**

- New QA engineers (primary onboarding use case)
- Developers who need testing knowledge
- Anyone at the company requiring testing fundamentals through advanced practices
- Scalable to entire team without manual teaching

**What It Produces:**

- Multi-session learning journey (7 sessions, 30-90 min each)
- Session-by-session progress tracking via persistent state file
- Learning artifacts: session notes, test files, reports, completion certificate
- Personalized learning paths customized by role (QA vs Dev vs Lead vs VP)
- Knowledge validation through quizzes after each session
- Resume capability - users can pause and continue across days/weeks

**Key Insights:**

- Content volume (~24k lines) makes single-session teaching infeasible
- State persistence is critical for multi-session continuity
- Just-in-time content loading per session keeps context manageable
- First use case: new QA onboarding completing in 1-2 weeks
- Workflow must reference and integrate TEA docs and knowledge base extensively
- Users learn at their own pace without requiring instructor availability

**Technical Architecture Requirements:**

- 7-session curriculum structure
- State file: tracks progress, scores, completed sessions, artifacts, next recommended session
- Role-based path customization
- Knowledge validation gates between sessions
- Artifact generation per session
- Integration with TEA module documentation and knowledge base

## Classification Decisions

**Workflow Name:** teach-me-testing
**Target Path:** {project-root}/src/workflows/testarch/teach-me-testing/

**4 Key Decisions:**

1. **Document Output:** Yes (produces progress files, session notes, artifacts, completion certificate)
2. **Module Affiliation:** TEA module (9th workflow in test architecture)
3. **Session Type:** Continuable (multi-session learning over 1-2 weeks)
4. **Lifecycle Support:** Tri-modal (Create + Edit + Validate for future-proofing)

**Structure Implications:**

- **Tri-modal architecture:** Needs `steps-c/`, `steps-e/`, `steps-v/` folders
- **Continuable workflow:** Requires `step-01-init.md` with continuation detection + `step-01b-continue.md` for resuming
- **State tracking:** Uses `stepsCompleted` in progress file frontmatter
- **Document templates:** Progress tracking YAML, session notes markdown, completion certificate
- **Module integration:** Access to TEA module variables, docs paths, knowledge base paths
- **Data folder:** Shared data for curriculum structure, role paths, session content mappings

## Requirements

**Flow Structure:**

- Pattern: Mixed (non-linear between sessions, linear within sessions, branching at start only)
- Phases: Initial assessment → Session selection (non-linear) → Session execution (linear: teach → quiz → artifact) → Completion
- Estimated steps: Init + Continue + Assessment + 7 Session steps + Final Polish/Certificate generation = ~10-12 core step files
- Session jumping: Users can skip to any session based on experience level
- Within session: Strictly linear progression through teaching content

**User Interaction:**

- Style: Mixed (mostly autonomous teaching with collaborative decision points)
- Decision points:
  - Role/experience assessment (entry)
  - Session selection (menu-driven, can jump around)
  - Quiz answers (validation gates)
  - Continue to next session or exit
- Checkpoint frequency: At session completion (save progress, offer continue/exit)
- Teaching approach: AI presents content, user absorbs - minimal interruption once learning

**Inputs Required:**

- Required:
  - User role (QA, Dev, Lead, VP)
  - Experience level (beginner, intermediate, experienced)
  - Learning goals (fundamentals, TEA-specific, advanced patterns)
- Optional:
  - Existing project for practical examples
  - Specific pain points (flaky tests, slow tests, hard to maintain)
- Prerequisites:
  - TEA module installed
  - Access to TEA docs and knowledge base
  - Understanding of time commitment (30-90 min per session)

**Output Specifications:**

- Type: Multiple document types
- Format: Mixed formats
  - Progress file: Structured YAML with specific schema (sessions, scores, artifacts, completed_date, next_recommended)
  - Session notes: Free-form markdown built progressively per session
  - Completion certificate: Structured format with completion data
- Sections:
  - Progress file has fixed schema
  - Session notes vary by session content
  - Certificate has standard completion fields
- Frequency:
  - Progress file: Updated after each session
  - Session notes: Generated per session
  - Certificate: Generated at final completion

**Success Criteria:**

- User completes their chosen sessions (might be 1, might be all 7)
- Knowledge validated through quizzes (≥70% passing threshold)
- Artifacts generated successfully (progress file exists, session notes created, learning tracked)
- User can apply knowledge (write their first good test following TEA principles)
- Onboarding velocity achieved (new QAs complete core sessions within 1-2 weeks)
- Scalability proven (multiple team members learn without requiring instructor time)

**Instruction Style:**

- Overall: Mixed (prescriptive for structure, intent-based for teaching)
- Prescriptive for:
  - Initial assessment (consistent role/experience classification)
  - Quiz questions (need exact validation logic)
  - Progress tracking (exact state file updates)
  - Session navigation (clear menu structure)
- Intent-based for:
  - Teaching sessions (AI adapts explanations naturally)
  - Example selection (AI chooses relevant TEA docs/knowledge fragments)
  - Artifact generation (AI synthesizes learning into notes)
  - Role-flavored content (AI adjusts examples based on user role)

## Tools Configuration

**Core BMAD Tools:**

- **Party Mode:** Included (optional via A/P menu) - Use for collaborative exploration when the learner wants a lighter format
- **Advanced Elicitation:** Included (optional via A/P menu) - Use for deeper discovery or clarification during sessions
- **Brainstorming:** Excluded - Not needed for structured curriculum delivery

**LLM Features:**

- **Web-Browsing:** Included - Use case: Safety net for framework updates (Cypress, Jest, newer Playwright versions) and frameworks not covered in TEA docs. Motto: "Only reach out when you don't have the info"
- **File I/O:** Included - Operations: Read TEA docs (/docs/_.md), read knowledge fragments (/src/testarch/knowledge/_.md), write progress file ({user}-tea-progress.yaml), write session notes, write completion certificate
- **Sub-Agents:** Excluded - Sessions are linear teaching steps handled by TEA agent, not complex specialized tasks requiring delegation
- **Sub-Processes:** Excluded - Learning is sequential (one session at a time), no parallel processing needed

**Memory:**

- Type: Continuable workflow with persistent state
- Tracking:
  - `stepsCompleted` array in progress YAML
  - Session completion tracking (id, status, completed_date, score, artifacts)
  - Progress metrics (completion_percentage, next_recommended)
  - Progress file structure:
    ```yaml
    user: { user_name }
    role: { qa/dev/lead/vp }
    sessions: [{ id, status, completed_date, score, artifacts }]
    completion_percentage: { percent }
    next_recommended: { session-id }
    ```
  - Continuation support via step-01b-continue.md with progress dashboard

**External Integrations:**

- None - Self-contained within TEA module, no external databases/APIs/MCP servers needed

**Installation Requirements:**

- None - All selected tools are built-in (Web-Browsing and File I/O are standard LLM features)
- User preference: N/A (no installations required)

## Workflow Design

### Complete Flow Overview

**Entry → Init (check for progress) → [New User: Assessment | Returning User: Dashboard] → Session Menu (hub) → Sessions 1-7 (loop back to menu) → Completion Certificate**

### Step Structure (CREATE mode - steps-c/)

**Total: 12 step files**

#### Phase 1: Initialization & Continuation

1. **step-01-init.md** (Init Step - Continuable)
   - Goal: Welcome user, check for existing progress file, explain workflow, create initial progress if new
   - Type: Init (Continuable) - checks for `{user}-tea-progress.yaml`, routes to step-01b if exists
   - Menu: Auto-proceed (Pattern 3) - no user menu
   - Logic: Checks for existing progress → routes to step-01b if exists, otherwise creates new and proceeds to step-02

2. **step-01b-continue.md** (Continuation Step)
   - Goal: Load existing progress, show dashboard with completion status, route to session menu
   - Type: Continuation - reads `stepsCompleted`, displays progress percentage
   - Menu: Auto-proceed (Pattern 3) - no user menu
   - Logic: Shows progress dashboard → auto-routes to step-03-session-menu

#### Phase 2: Assessment & Path Selection

3. **step-02-assess.md** (Middle Step - Standard)
   - Goal: Gather role (QA/Dev/Lead/VP), experience level, learning goals, optional pain points
   - Type: Middle (Standard) auto-proceed
   - Menu: Auto-proceed (Pattern 3) - no user menu
   - On completion: Saves assessment to progress file → loads step-03-session-menu

4. **step-03-session-menu.md** (Branch Step - Hub)
   - Goal: Present 7 sessions with descriptions + completion status, allow non-linear selection
   - Type: Branch Step (custom menu: 1-7, X for exit)
   - Menu: Custom branching (Pattern 4)
   - Display: [1-7] Select session | [X] Exit
   - Logic:
     - 1-7: Routes to corresponding session step
     - X: If all sessions complete → routes to step-05-completion; if incomplete → saves and exits
   - **This is the hub - all sessions return here**

#### Phase 3: Session Execution (7 Sessions)

5-11. **step-04-session-[01-07].md** (Middle Steps - Complex)

- Each session follows same pattern:
  - Loads relevant TEA docs just-in-time
  - Presents teaching content (mostly autonomous)
  - Knowledge validation quiz (collaborative)
  - Generates session notes artifact
  - Updates progress file
  - Returns to step-03-session-menu
- Menu: Standard A/P/C (Pattern 1) - users might want Advanced Elicitation
- On C: Saves session notes, updates progress (mark complete, update score), returns to hub

**Sessions:**

- **session-01**: Quick Start (30 min) - TEA Lite intro, run automate workflow
- **session-02**: Core Concepts (45 min) - Risk-based testing, DoD, philosophy
- **session-03**: Architecture (60 min) - Fixtures, network patterns, framework
- **session-04**: Test Design (60 min) - Risk assessment workflow
- **session-05**: ATDD & Automate (60 min) - ATDD + Automate workflows
- **session-06**: Quality & Trace (45 min) - Test review + Trace workflows
- **session-07**: Advanced Patterns (ongoing) - Menu-driven knowledge fragment exploration

#### Phase 4: Completion

12. **step-05-completion.md** (Final Step)
    - Goal: Generate completion certificate, final progress update, congratulate
    - Type: Final - no nextStepFile, marks workflow complete
    - Menu: None (final step)
    - Logic: Generates certificate, displays congratulations, workflow ends

### Interaction Patterns

- **Auto-proceed steps:** step-01-init, step-01b-continue, step-02-assess
- **Standard A/P/C:** step-04-session-[01-07]
- **Custom branching:** step-03-session-menu (hub)
- **No menu:** step-05-completion (final)

### Data Flow

**Progress File:** `{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml`

**Schema:**

```yaml
user: { user_name }
role: { qa/dev/lead/vp }
experience_level: { beginner/intermediate/experienced }
learning_goals: [list]
pain_points: [optional list]
started_date: 2026-01-27
last_session_date: 2026-01-27

sessions:
  - id: session-01-quickstart
    status: completed
    completed_date: 2026-01-27
    score: 90
    notes_artifact: "{test_artifacts}/tea-academy/{user_name}/session-01-notes.md"
  - id: session-02-concepts
    status: in-progress
    started_date: 2026-01-27
  # ... sessions 03-07

sessions_completed: 1
total_sessions: 7
completion_percentage: 14
next_recommended: session-02-concepts

stepsCompleted: ["step-01-init", "step-02-assess", "step-04-session-01"]
lastStep: "step-04-session-01"
lastContinued: "2026-01-27"
```

**Data Flow Per Step:**

- **step-01-init:** Creates initial progress YAML if new
- **step-01b-continue:** Reads progress file, updates lastContinued
- **step-02-assess:** Updates role, experience, goals, pain_points
- **step-03-session-menu:** Reads sessions array (display status)
- **step-04-session-[N]:** Reads progress (for role), writes session notes, updates sessions array
- **step-05-completion:** Reads all sessions data, writes certificate

**Error Handling:**

- Quiz failure (<70%): Offer review or continue anyway
- Missing TEA docs: Use Web-Browsing fallback
- Corrupted progress: Backup and offer fresh start
- Session interrupted: Auto-save after quiz completion

**Checkpoints:**

- After assessment complete
- After each quiz completion
- After each session artifact generation
- On user exit from session menu

### File Structure

```
teach-me-testing/
├── workflow.md                              # Main entry point
├── workflow.yaml                            # Workflow metadata
│
├── steps-c/                                 # CREATE mode (12 steps)
│   ├── step-01-init.md
│   ├── step-01b-continue.md
│   ├── step-02-assess.md
│   ├── step-03-session-menu.md
│   ├── step-04-session-01.md
│   ├── step-04-session-02.md
│   ├── step-04-session-03.md
│   ├── step-04-session-04.md
│   ├── step-04-session-05.md
│   ├── step-04-session-06.md
│   ├── step-04-session-07.md
│   └── step-05-completion.md
│
├── steps-e/                                 # EDIT mode (2 steps)
│   ├── step-e-01-assess-workflow.md
│   └── step-e-02-apply-edits.md
│
├── steps-v/                                 # VALIDATE mode (1 step)
│   └── step-v-01-validate.md
│
├── data/                                    # Shared data files
│   ├── curriculum.yaml
│   ├── role-paths.yaml
│   ├── session-content-map.yaml
│   ├── quiz-questions.yaml
│   └── tea-resources-index.yaml
│
├── templates/                               # Document templates
│   ├── progress-template.yaml
│   ├── session-notes-template.md
│   └── certificate-template.md
│
├── instructions.md
└── checklist.md
```

### Role and Persona Definition

**AI Role:** Master Test Architect and Teaching Guide

**Expertise:**

- Deep knowledge of testing principles (risk-based, test pyramid, types)
- Expert in TEA methodology (9 workflows, architecture patterns, 35 knowledge fragments)
- Familiar with Playwright, test automation, CI/CD
- Teaching pedagogy: progressive learning, knowledge validation, role-based examples

**Communication Style:**

- **Teaching:** Clear, patient, educational - adapts complexity by role
- **Quizzes:** Encouraging, constructive feedback, non-judgmental
- **Navigation:** Clear, concise, shows completion status prominently
- **Tone:** Encouraging but not patronizing, technical but accessible

**Teaching Principles:**

1. Just-in-time learning (load content when needed)
2. Active recall (quiz after teaching)
3. Spaced repetition (reference earlier concepts)
4. Role-flavored examples (same concept, different contexts)
5. Artifact generation (learners keep notes)

### Validation and Error Handling

**Output Validation:**

- Progress file: Schema, status, score (0-100), date, artifact paths
- Session notes: Frontmatter present, content not empty (min 100 chars)
- Certificate: All 7 sessions complete, valid dates, user info present

**User Input Validation:**

- Role: Must be QA, Dev, Lead, or VP
- Experience: beginner, intermediate, or experienced
- Quiz answers: 3 attempts before showing correct answer
- Session selection: Must be 1-7 or X

**Error Recovery:**

- Corrupted progress: Backup, offer fresh start
- Missing docs: Web-Browsing fallback
- Quiz failure: Review or continue options
- Interrupted session: Auto-save progress

**Success Criteria:**

- Session complete: Content presented, quiz passed, notes generated, progress updated
- Workflow complete: All 7 sessions done, avg score ≥70%, artifacts created, certificate generated

### Special Features

**Conditional Logic:**

- Session menu routing: Check if all complete → route to completion or show menu
- Quiz scoring: If ≥70% proceed, if <70% offer review

**Branch Points:**

- Initial entry: Progress exists? → continue vs new
- Experience-based recommendations: Beginner → session 1, Experienced → session 7

**Integration with TEA Workflows:**

- Session 1: Demonstrates [TA] Automate
- Session 3: May run [TF] Framework
- Session 4: Runs [TD] Test Design
- Session 5: Runs [AT] ATDD + [TA] Automate
- Session 6: Runs [RV] Test Review + [TR] Trace

**Role-Based Content:**

- QA: Practical testing focus
- Dev: Integration and TDD focus
- Lead: Architecture and patterns focus
- VP: Strategy and metrics focus

**Session 7 Special Handling:**

- Exploratory menu-driven deep-dive into 35 knowledge fragments
- Organized by categories (Testing Patterns, Playwright Utils, Config/Governance, etc.)
- Links to GitHub for browsing

**Content Sources (Triple Reference System):**

- Local files: `/docs/*.md`, `/src/testarch/knowledge/*.md`
- Online docs: `<https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/`>
- GitHub fragments: Direct links to knowledge fragment source files

### Design Summary

**Complete:** 12-step CREATE workflow with hub pattern
**Continuable:** Progress file tracks state across sessions
**Non-linear:** Users jump to any session from hub
**Role-flavored:** Same concepts, role-specific examples
**Triple content:** Local + online + GitHub sources
**Web-Browsing:** Fallback for missing/updated docs
**Auto-save:** After each session completion
**Tri-modal:** Create (12 steps) + Edit (2 steps) + Validate (1 step)

## Foundation Build Complete

**Created:** 2026-01-28

**Folder Structure:**

```
teach-me-testing/
├── workflow.md                           ✓ Created
├── steps-c/                              ✓ Created (empty, to be populated)
├── steps-e/                              ✓ Created (empty, to be populated)
├── steps-v/                              ✓ Created (empty, to be populated)
├── data/                                 ✓ Created (empty, to be populated)
├── templates/                            ✓ Created
│   ├── progress-template.yaml            ✓ Created
│   ├── session-notes-template.md         ✓ Created
│   └── certificate-template.md           ✓ Created
├── instructions.md                       ✓ Created
└── checklist.md                          ✓ Created
```

**Location:** {external-project-root}/\_bmad-output/bmb-creations/workflows/teach-me-testing/

**Configuration:**

- Workflow name: teach-me-testing
- Continuable: Yes (multi-session learning)
- Document output: Yes (Progress YAML, Session notes MD, Certificate MD)
- Mode: Tri-modal (Create + Edit + Validate)
- Module: TEA (Test Architecture Enterprise)

**Files Created:**

1. **workflow.md**
   - Tri-modal routing logic (Create/Edit/Validate)
   - Configuration loading from TEA module
   - Step-file architecture principles
   - Initialization sequence

2. **templates/progress-template.yaml**
   - Complete progress tracking schema
   - 7 sessions defined
   - Session status tracking (not-started/in-progress/completed)
   - stepsCompleted array for continuation
   - Progress metrics (completion_percentage, next_recommended)

3. **templates/session-notes-template.md**
   - Session metadata
   - Key concepts, objectives, takeaways
   - TEA resources referenced
   - Quiz results
   - Practical examples

4. **templates/certificate-template.md**
   - Completion certificate structure
   - All 7 sessions with scores
   - Skills acquired checklist
   - Learning artifacts paths
   - Next steps recommendations

5. **instructions.md**
   - How to run the workflow
   - Session structure and flow
   - Progress tracking details
   - Troubleshooting guide

6. **checklist.md**
   - Quality validation checklist
   - Foundation quality checks
   - Step file quality standards
   - Data file quality requirements
   - Completion criteria

**Next Steps:**

- Step 8: Build step-01-init.md (initialization with continuation detection)
- Step 9: Build step-01b-continue.md (continuation/resume logic)
- Step 10+: Build remaining 10 step files (assessment, session menu, 7 sessions, completion)
- Populate data/ folder with curriculum, role paths, session content map, quizzes, resources index

## Step 01 Build Complete

**Created:** 2026-01-28

**Files:**

- `steps-c/step-01-init.md` ✓
- `steps-c/step-01b-continue.md` ✓

**Step Configuration:**

- **Type:** Continuable (multi-session learning)
- **Input Discovery:** No (self-contained teaching)
- **Progress File:** `{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml`
- **Menu Pattern:** Auto-proceed (no user menu)

**step-01-init.md:**

- Checks for existing progress file
- If exists → routes to step-01b-continue
- If not → creates new progress from template, proceeds to step-02-assess
- Initializes stepsCompleted array
- Creates complete session tracking structure (all 7 sessions)

**step-01b-continue.md:**

- Loads existing progress file
- Updates lastContinued timestamp
- Displays progress dashboard with completion status
- Shows session indicators (✅ completed, 🔄 in-progress, ⬜ not-started)
- Auto-routes to step-03-session-menu (hub)

**Frontmatter Compliance:**

- All variables used in step body
- Relative paths for internal references
- No hardcoded paths
- Follows frontmatter standards

**Next Steps:**

- Build step-02-assess.md (assessment)
- Build step-03-session-menu.md (hub)
- Build 7 session steps (step-04-session-01 through step-04-session-07)
- Build step-05-completion.md (certificate generation)

## Step 02 Build Complete

**Created:** 2026-01-28

**Files:**

- `steps-c/step-02-assess.md` ✓

**Step Configuration:**

- **Type:** Middle Step (Standard) auto-proceed
- **Next Step:** step-03-session-menu
- **Menu Pattern:** Auto-proceed (Pattern 3) - no user menu

**step-02-assess.md:**

- Gathers role (QA/Dev/Lead/VP) with validation
- Gathers experience level (beginner/intermediate/experienced) with validation
- Gathers learning goals (required, validated)
- Gathers pain points (optional)
- Updates progress file with all assessment data
- Provides experience-based session recommendations
- Updates stepsCompleted array with 'step-02-assess'
- Routes to step-03-session-menu (hub)

**Frontmatter Compliance:**

- All variables used in step body
- Relative paths for internal references
- No hardcoded paths
- Follows frontmatter standards

**Remaining Steps:** 9 more to build

- step-03-session-menu (hub with branching)
- step-04-session-01 through step-04-session-07 (7 teaching sessions)
- step-05-completion (certificate generation)

## Step 03 Build Complete

**Created:** 2026-01-28

**Files:**

- `steps-c/step-03-session-menu.md` ✓

**Step Configuration:**

- **Type:** Branch Step (Hub) with custom menu (1-7, X)
- **Routes To:** Any of 7 sessions OR completion OR exit
- **Menu Pattern:** Custom branching (Pattern 4)

**step-03-session-menu.md:**

- Loads progress file to get session completion status
- Displays all 7 sessions with status indicators (✅ completed, 🔄 in-progress, ⬜ not-started)
- Shows completion percentage and scores
- Provides session descriptions and durations
- Recommends next session based on progress
- Detects when all 7 sessions complete → routes to completion
- Allows non-linear session selection (jump to any session)
- Exit option (X) saves progress and ends workflow
- This is the HUB - all sessions return here
- No stepsCompleted update (routing hub, not content step)

**Routing Logic:**

- 1-7 → Routes to corresponding session step
- X → Saves and exits workflow
- All complete → Auto-routes to step-05-completion

**Frontmatter Compliance:**

- All 7 session file references used in routing logic
- Completion file reference used for all-done scenario
- Progress file loaded for status display
- Relative paths for all step files

**Remaining Steps:** 8 more to build

- step-04-session-01 through step-04-session-07 (7 teaching sessions)
- step-05-completion (certificate generation)

## Step 04-Session-01 Build Complete

**Created:** 2026-01-28

**Files:**

- `steps-c/step-04-session-01.md` ✓

**Step Configuration:**

- **Type:** Middle Step (Complex) with A/P/C menu
- **Session:** Quick Start (30 min)
- **Next Step:** Returns to step-03-session-menu (hub)
- **Menu Pattern:** Standard A/P/C (Pattern 1)

**step-04-session-01.md:**

- Session 1: Quick Start - TEA Lite intro, run automate workflow
- Updates progress (status: in-progress at start, completed at end)
- Teaching content: What is TEA, TEA Lite, Automate workflow, engagement models
- Role-adapted examples (QA/Dev/Lead/VP perspectives)
- 3-question quiz with validation (passing: ≥70%)
- Quiz retry option if failing (<70%)
- Generates session notes using template with all quiz results
- Updates progress file (status, score, notes_artifact, completion_percentage)
- Updates stepsCompleted array with 'step-04-session-01'
- Returns to session menu hub (step-03)

**Teaching Topics:**

- What is TEA and why it exists
- 9 workflows + 35 knowledge fragments
- Quality standards (Definition of Done)
- Risk-based testing (P0-P3 matrix)
- TEA engagement models (Lite/Solo/Integrated/Enterprise/Brownfield)
- Automate workflow conceptual overview

**TEA Resources Referenced:**

- TEA Overview, TEA Lite Quickstart, Automate Workflow docs
- Online URLs provided for further reading

**Remaining Steps:** 7 more to build

- step-04-session-02 through step-04-session-07 (6 more teaching sessions)
- step-05-completion (certificate generation)

## Step 04-Session-02 Build Complete

**Created:** 2026-01-28
**Files:** `steps-c/step-04-session-02.md` ✓
**Session:** Core Concepts (45 min) - Testing as Engineering, Risk-based testing (P0-P3), TEA Definition of Done
**Pattern:** Middle Step (Complex) with A/P/C menu, returns to hub
**Teaching:** Philosophy, risk matrix, quality standards with role-adapted examples
**Quiz:** 3 questions on P0-P3, hard waits, self-cleaning tests
**Knowledge Fragments:** test-quality.md, probability-impact.md

**Remaining:** 6 steps (sessions 03-07 + completion)

## Step 04-Session-03 Build Complete

**Created:** 2026-01-28
**Files:** `steps-c/step-04-session-03.md` ✓
**Session:** Architecture & Patterns (60 min)
**Topics:** Fixture composition, network-first patterns, data factories, step-file architecture
**Knowledge Fragments:** fixture-architecture.md, network-first.md, data-factories.md
**Quiz:** 3 questions on fixtures, network-first, step-file architecture

## Step 04-Session-04 Build Complete

**Created:** 2026-01-28
**Files:** `steps-c/step-04-session-04.md` ✓
**Session:** Test Design (60 min)
**Topics:** Test Design workflow, risk/testability assessment, coverage planning, test priorities matrix
**Knowledge Fragments:** test-levels-framework.md, test-priorities-matrix.md
**Quiz:** 3 questions on test design, risk calculation, P0 coverage

## Step 04-Session-05 Build Complete

**Created:** 2026-01-28
**Files:** `steps-c/step-04-session-05.md` ✓
**Session:** ATDD & Automate (60 min)
**Topics:** ATDD workflow (red-green TDD), Automate workflow, component TDD, API testing patterns
**Knowledge Fragments:** component-tdd.md, api-testing-patterns.md, api-request.md
**Quiz:** 3 questions on TDD red phase, ATDD vs Automate, API testing

## Step 04-Session-06 Build Complete

**Created:** 2026-01-28
**Files:** `steps-c/step-04-session-06.md` ✓
**Session:** Quality & Trace (45 min)
**Topics:** Test Review workflow (5 dimensions), Trace workflow, quality metrics
**Quiz:** 3 questions on quality dimensions, release gates, metrics

## Step 04-Session-07 Build Complete

**Created:** 2026-01-28
**Files:** `steps-c/step-04-session-07.md` ✓
**Session:** Advanced Patterns (ongoing)
**Format:** Menu-driven exploration of 35 knowledge fragments
**Categories:** Testing Patterns (9), Playwright Utils (11), Config/Governance (6), Quality Frameworks (5), Auth/Security (3)
**No Quiz:** Exploratory session, score: 100 on completion
**Special:** Repeatable, user can explore multiple fragments, returns to hub

## Step 05-Completion Build Complete

**Created:** 2026-01-28
**Files:** `steps-c/step-05-completion.md` ✓
**Type:** Final Step (no next step)
**Purpose:** Verify all 7 sessions complete, generate certificate, final progress update, celebrate
**Certificate:** Includes all session scores, skills acquired, learning artifacts, next steps
**Final:** Updates progress (certificate_generated: true, completion_date)
**No Menu:** Workflow ends here

---

## CREATE Mode Build Complete (12 Steps)

**All CREATE mode steps built:** ✓

1. step-01-init.md - Initialize with continuation detection
2. step-01b-continue.md - Resume with progress dashboard
3. step-02-assess.md - Role/experience assessment
4. step-03-session-menu.md - Session selection hub
5. step-04-session-01.md - Quick Start
6. step-04-session-02.md - Core Concepts
7. step-04-session-03.md - Architecture & Patterns
8. step-04-session-04.md - Test Design
9. step-04-session-05.md - ATDD & Automate
10. step-04-session-06.md - Quality & Trace
11. step-04-session-07.md - Advanced Patterns
12. step-05-completion.md - Certificate generation

**Remaining:**

- Data files (curriculum.yaml, role-paths.yaml, session-content-map.yaml, quiz-questions.yaml, tea-resources-index.yaml)
- EDIT mode steps (2 steps)
- VALIDATE mode steps (1 step)

---

## Data Files Build Complete

**Created:** 2026-01-28

**Files:**

1. `data/curriculum.yaml` ✓ - 7-session structure, learning paths by experience, completion requirements
2. `data/role-paths.yaml` ✓ - Role customizations for QA/Dev/Lead/VP with focus areas and teaching adaptations
3. `data/session-content-map.yaml` ✓ - Maps sessions to TEA docs, knowledge fragments, online URLs, workflows
4. `data/quiz-questions.yaml` ✓ - Question bank for sessions 1-6 (session 7 is exploratory, no quiz)
5. `data/tea-resources-index.yaml` ✓ - Comprehensive index of 32 docs + 35 knowledge fragments with GitHub links

**All 5 data files complete.**

---

## EDIT Mode Build Complete

**Created:** 2026-01-28

**Files:**

1. `steps-e/step-e-01-assess-workflow.md` ✓ - Identify what to edit, gather edit requirements
2. `steps-e/step-e-02-apply-edits.md` ✓ - Apply modifications with user approval, validate integrity

**All 2 EDIT mode steps complete.**

---

## VALIDATE Mode Build Complete

**Created:** 2026-01-28

**Files:**

1. `steps-v/step-v-01-validate.md` ✓ - Comprehensive quality validation against BMAD standards, generates validation report

**All 1 VALIDATE mode step complete.**

---

## 🏆 WORKFLOW BUILD COMPLETE

**Status:** ✅ 100% COMPLETE

**Total Files Created:** 24 files

### Foundation (6 files)

- workflow.md
- instructions.md
- checklist.md
- workflow-plan-teach-me-testing.md
- (plus 3 templates)

### Templates (3 files)

- progress-template.yaml
- session-notes-template.md
- certificate-template.md

### CREATE Mode (12 step files)

- step-01-init.md
- step-01b-continue.md
- step-02-assess.md
- step-03-session-menu.md
- step-04-session-01.md through step-04-session-07.md (7 sessions)
- step-05-completion.md

### Data Files (5 files)

- curriculum.yaml
- role-paths.yaml
- session-content-map.yaml
- quiz-questions.yaml
- tea-resources-index.yaml

### EDIT Mode (2 step files)

- step-e-01-assess-workflow.md
- step-e-02-apply-edits.md

### VALIDATE Mode (1 step file)

- step-v-01-validate.md

---

## Next Action Required

**DEPLOYMENT:** Move workflow from staging to TEA module

**Source (Staging):**
`{external-project-root}/_bmad-output/bmb-creations/workflows/teach-me-testing/`

**Target (Production):**
`{project-root}/src/workflows/testarch/teach-me-testing/`

**Command:**

```bash
cp -r {external-project-root}/_bmad-output/bmb-creations/workflows/teach-me-testing \
      {project-root}/src/workflows/testarch/
```

**After deployment:**

1. Update TEA agent menu to add [TMT] Teach Me Testing
2. Test the workflow: `bmad run teach-me-testing`
3. Validate: `bmad run teach-me-testing -v`
4. Document in TEA module README

---

**Workflow Creation: COMPLETE** ✅
**Ready for Deployment:** YES
**Validation Status:** Not yet validated (run -v mode after deployment)
