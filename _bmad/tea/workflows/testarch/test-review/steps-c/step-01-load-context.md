---
name: "step-01-load-context"
description: "Load knowledge base, determine scope, and gather context"
nextStepFile: "./step-02-discover-tests.md"
knowledgeIndex: "{project-root}/_bmad/tea/testarch/tea-index.csv"
outputFile: "{test_artifacts}/test-review.md"
---

# Step 1: Load Context & Knowledge Base

## STEP GOAL

Determine review scope, load required knowledge fragments, and gather related artifacts.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`

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

## 1. Determine Scope and Stack

Use `review_scope`:

- **single**: one file
- **directory**: all tests in folder
- **suite**: all tests in repo

If unclear, ask the user.

**Stack Detection** (for context-aware loading):

Read `test_stack_type` from `{config_source}`. If `"auto"` or not configured, infer `{detected_stack}` by scanning `{project-root}`:

- **Frontend indicators**: `playwright.config.*`, `cypress.config.*`, `package.json` with react/vue/angular
- **Backend indicators**: `pyproject.toml`, `pom.xml`/`build.gradle`, `go.mod`, `*.csproj`, `Gemfile`, `Cargo.toml`
- **Both present** → `fullstack`; only frontend → `frontend`; only backend → `backend`
- Explicit `test_stack_type` overrides auto-detection

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

**If `tea_use_pactjs_utils` is enabled** (and contract tests detected in review scope):

Load: `pactjs-utils-overview.md`, `pactjs-utils-provider-verifier.md`, `pactjs-utils-request-filter.md` (the 3 most relevant for reviewing provider verification tests)

**If `tea_use_pactjs_utils` is disabled** but contract tests are in review scope:

Load: `contract-testing.md`

### Pact MCP Loading

**If `tea_pact_mcp` is `"mcp"`:**

Load: `pact-mcp.md` — enables agent to use SmartBear MCP "Review Pact Tests" tool for automated best-practice feedback during test review.

## 2. Load Knowledge Base

From `{knowledgeIndex}` load:

Read `{config_source}` and check `tea_use_playwright_utils`, `tea_use_pactjs_utils`, `tea_pact_mcp`, and `tea_browser_automation` to select the correct fragment set.

**Core:**

- `test-quality.md`
- `data-factories.md`
- `test-levels-framework.md`
- `selective-testing.md`
- `test-healing-patterns.md`
- `selector-resilience.md`
- `timing-debugging.md`

**If Playwright Utils enabled:**

- `overview.md`, `api-request.md`, `network-recorder.md`, `auth-session.md`, `intercept-network-call.md`, `recurse.md`, `log.md`, `file-utils.md`, `burn-in.md`, `network-error-monitor.md`, `fixtures-composition.md`

**If disabled:**

- `fixture-architecture.md`
- `network-first.md`
- `playwright-config.md`
- `component-tdd.md`
- `ci-burn-in.md`

**Playwright CLI (if `tea_browser_automation` is "cli" or "auto"):**

- `playwright-cli.md`

**MCP Patterns (if `tea_browser_automation` is "mcp" or "auto"):**

- (existing MCP-related fragments, if any are added in future)

**Pact.js Utils (if enabled and contract tests in review scope):**

- `pactjs-utils-overview.md`, `pactjs-utils-provider-verifier.md`, `pactjs-utils-request-filter.md`

**Contract Testing (if pactjs-utils disabled but contract tests in review scope):**

- `contract-testing.md`

**Pact MCP (if tea_pact_mcp is "mcp"):**

- `pact-mcp.md`

---

## 3. Gather Context Artifacts

If available:

- Story file (acceptance criteria)
- Test design doc (priorities)
- Framework config

Summarize what was found.

Coverage mapping and coverage gates are out of scope in `test-review`. Route those concerns to `trace`.

---

## 4. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it using the workflow template (if available) with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-01-load-context"]
  lastStep: "step-01-load-context"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-01-load-context'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-01-load-context'`
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
