---
name: "step-02-load-context"
description: "Load documents, configuration, and knowledge fragments for the chosen mode"
nextStepFile: "./step-03-risk-and-testability.md"
knowledgeIndex: "{project-root}/_bmad/tea/testarch/tea-index.csv"
outputFile: "{test_artifacts}/test-design-progress.md"
---

# Step 2: Load Context & Knowledge Base

## STEP GOAL

Load the required documents, config flags, and knowledge fragments needed to produce accurate test design outputs.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- 🎯 Only load artifacts required for the selected mode

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Record outputs before proceeding
- 📖 Load the next step only when instructed

## CONTEXT BOUNDARIES:

- Available context: config, loaded artifacts, and knowledge fragments
- Focus: this step's goal only
- Limits: do not execute future steps
- Dependencies: prior steps' outputs (if any)

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise.

## 1. Load Configuration

From `{config_source}`:

- Read `tea_use_playwright_utils`
- Read `tea_use_pactjs_utils`
- Read `tea_pact_mcp`
- Read `tea_browser_automation`
- Read `test_stack_type` (if not set, default to `"auto"`)
- Note `test_artifacts`

**Stack Detection** (for context-aware loading):

If `test_stack_type` is `"auto"` or not configured, infer `{detected_stack}` by scanning `{project-root}`:

- **Frontend indicators**: `playwright.config.*`, `cypress.config.*`, `package.json` with react/vue/angular
- **Backend indicators**: `pyproject.toml`, `pom.xml`/`build.gradle`, `go.mod`, `*.csproj`, `Gemfile`, `Cargo.toml`
- **Both present** → `fullstack`; only frontend → `frontend`; only backend → `backend`
- Explicit `test_stack_type` overrides auto-detection

---

## 2. Load Project Artifacts (Mode-Specific)

### System-Level Mode (Phase 3)

Load:

- PRD (FRs + NFRs)
- ADRs or architecture decisions
- Architecture / tech-spec document
- Epics (for scope)

Extract:

- Tech stack & dependencies
- Integration points
- NFRs (performance, security, reliability, compliance)

### Epic-Level Mode (Phase 4)

Load:

- Epic and story docs with acceptance criteria
- PRD (if available)
- Architecture / tech-spec (if available)
- Prior system-level test-design outputs (if available)

Extract:

- Testable requirements
- Integration points
- Known coverage gaps

---

## 3. Analyze Existing Test Coverage (Epic-Level)

If epic-level:

- Scan the repository for existing tests (search for `tests/`, `spec`, `e2e`, `api` folders)
- Identify coverage gaps and flaky areas
- Note existing fixture and test patterns

### Browser Exploration (if `tea_browser_automation` is `cli` or `auto`)

> **Fallback:** If CLI is not installed, fall back to MCP (if available) or skip browser exploration and rely on code/doc analysis.

**CLI Exploration Steps:**
All commands use the same named session to target the correct browser:

1. `playwright-cli -s=tea-explore open <target_url>`
2. `playwright-cli -s=tea-explore snapshot` → capture page structure and element refs
3. `playwright-cli -s=tea-explore screenshot --filename={test_artifacts}/exploration/explore-<page>.png`
4. Analyze snapshot output to identify testable elements and flows
5. `playwright-cli -s=tea-explore close`

Store artifacts under `{test_artifacts}/exploration/`

> **Session Hygiene:** Always close sessions using `playwright-cli -s=tea-explore close`. Do NOT use `close-all` — it kills every session on the machine and breaks parallel execution.

---

### Tiered Knowledge Loading

Load fragments based on their `tier` classification in `tea-index.csv`:

1. **Core tier** (always load): Foundational fragments required for this workflow
2. **Extended tier** (load on-demand): Load when deeper analysis is needed or when the user's context requires it
3. **Specialized tier** (load only when relevant): Load only when the specific use case matches (e.g., contract-testing only for microservices, email-auth only for email flows)

> **Context Efficiency**: Loading only core fragments reduces context usage by 40-50% compared to loading all fragments.

### Playwright Utils Loading Profiles

**If `tea_use_playwright_utils` is enabled**, select the appropriate loading profile:

- **API-only profile** (when `{detected_stack}` is `backend` or no `page.goto`/`page.locator` found in test files):
  Load: `overview`, `api-request`, `auth-session`, `recurse` (~1,800 lines)

- **Full UI+API profile** (when `{detected_stack}` is `frontend`/`fullstack` or browser tests detected):
  Load: all Playwright Utils core fragments (~4,500 lines)

**Detection**: Scan `{test_dir}` for files containing `page.goto` or `page.locator`. If none found, use API-only profile.

### Pact.js Utils Loading

**If `tea_use_pactjs_utils` is enabled** (and `{detected_stack}` is `backend` or `fullstack`, or microservices indicators detected):

Load: `pactjs-utils-overview.md`, `pactjs-utils-consumer-helpers.md`, `pactjs-utils-provider-verifier.md`, `pactjs-utils-request-filter.md`

**If `tea_use_pactjs_utils` is disabled** but contract testing is relevant:

Load: `contract-testing.md`

### Pact MCP Loading

**If `tea_pact_mcp` is `"mcp"`:**

Load: `pact-mcp.md` — enables agent to use SmartBear MCP "Fetch Provider States" and "Matrix" tools to understand existing contract landscape during test design.

## 4. Load Knowledge Base Fragments

Use `{knowledgeIndex}` to select and load only relevant fragments.

### System-Level Mode (Required)

- `adr-quality-readiness-checklist.md`
- `test-levels-framework.md`
- `risk-governance.md`
- `test-quality.md`

### Epic-Level Mode (Required)

- `risk-governance.md`
- `probability-impact.md`
- `test-levels-framework.md`
- `test-priorities-matrix.md`

**Playwright CLI (if `tea_browser_automation` is "cli" or "auto"):**

- `playwright-cli.md`

**MCP Patterns (if `tea_browser_automation` is "mcp" or "auto"):**

- (existing MCP-related fragments, if any are added in future)

**Pact.js Utils (if enabled — both System-Level and Epic-Level):**

- `pactjs-utils-overview.md`, `pactjs-utils-consumer-helpers.md`, `pactjs-utils-provider-verifier.md`, `pactjs-utils-request-filter.md`

**Contract Testing (if pactjs-utils disabled but relevant):**

- `contract-testing.md`

**Pact MCP (if tea_pact_mcp is "mcp"):**

- `pact-mcp.md`

---

## 5. Confirm Loaded Inputs

Summarize what was loaded and confirm with the user if anything is missing.

---

### 6. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-02-load-context"]
  lastStep: "step-02-load-context"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-02-load-context'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-02-load-context'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

**Update `inputDocuments`**: Set `inputDocuments` in the output template frontmatter to the list of artifact paths loaded in this step (e.g., knowledge fragments, test design documents, configuration files).

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
