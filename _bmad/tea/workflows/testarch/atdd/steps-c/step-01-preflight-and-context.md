---
name: "step-01-preflight-and-context"
description: "Verify prerequisites and load story, framework, and knowledge base"
outputFile: "{test_artifacts}/atdd-checklist-{story_id}.md"
nextStepFile: "./step-02-generation-mode.md"
knowledgeIndex: "{project-root}/_bmad/tea/testarch/tea-index.csv"
---

# Step 1: Preflight & Context Loading

## STEP GOAL

Verify prerequisites and load all required inputs before generating failing tests.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- 🚫 Halt if requirements are missing

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

## 1. Stack Detection

**Read `config.test_stack_type`** from `{config_source}`.

**Auto-Detection Algorithm** (when `test_stack_type` is `"auto"` or not configured):

- Scan `{project-root}` for project manifests:
  - **Frontend indicators**: `package.json` with react/vue/angular/next dependencies, `playwright.config.*`, `vite.config.*`, `webpack.config.*`
  - **Backend indicators**: `pyproject.toml`, `pom.xml`/`build.gradle`, `go.mod`, `*.csproj`/`*.sln`, `Gemfile`, `Cargo.toml`
  - **Both present** = `fullstack`; only frontend = `frontend`; only backend = `backend`
- Explicit `test_stack_type` config value overrides auto-detection
- **Backward compatibility**: if `test_stack_type` is not in config, treat as `"auto"` (preserves current frontend behavior for existing installs)

Store result as `{detected_stack}` = `frontend` | `backend` | `fullstack`

---

## 2. Prerequisites (Hard Requirements)

- Story approved with **clear acceptance criteria**
- Test framework configured:
  - **If {detected_stack} is `frontend` or `fullstack`:** `playwright.config.ts` or `cypress.config.ts`
  - **If {detected_stack} is `backend`:** relevant test config exists (e.g., `conftest.py`, `src/test/`, `*_test.go`, `.rspec`)
- Development environment available

If any are missing: **HALT** and notify the user.

---

## 3. Load Story Context

- Read story markdown from `{story_file}` (or ask user if not provided)
- Extract acceptance criteria and constraints
- Identify affected components and integrations

---

## 4. Load Framework & Existing Patterns

- Read framework config
- Inspect `{test_dir}` for existing test patterns, fixtures, helpers

## 4.5 Read TEA Config Flags

From `{config_source}`:

- `tea_use_playwright_utils`
- `tea_use_pactjs_utils`
- `tea_pact_mcp`
- `tea_browser_automation`
- `test_stack_type`

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

Load: `pact-mcp.md`

## 5. Load Knowledge Base Fragments

Use `{knowledgeIndex}` to load:

**Core (always):**

- `data-factories.md`
- `component-tdd.md`
- `test-quality.md`
- `test-healing-patterns.md`

**If {detected_stack} is `frontend` or `fullstack`:**

- `selector-resilience.md`
- `timing-debugging.md`

**Playwright Utils (if enabled and {detected_stack} is `frontend` or `fullstack`):**

- `overview.md`, `api-request.md`, `network-recorder.md`, `auth-session.md`, `intercept-network-call.md`, `recurse.md`, `log.md`, `file-utils.md`, `network-error-monitor.md`, `fixtures-composition.md`

**Playwright CLI (if tea_browser_automation is "cli" or "auto" and {detected_stack} is `frontend` or `fullstack`):**

- `playwright-cli.md`

**MCP Patterns (if tea_browser_automation is "mcp" or "auto" and {detected_stack} is `frontend` or `fullstack`):**

- (existing MCP-related fragments, if any are added in future)

**Traditional Patterns (if utils disabled and {detected_stack} is `frontend` or `fullstack`):**

- `fixture-architecture.md`
- `network-first.md`

**Backend Patterns (if {detected_stack} is `backend` or `fullstack`):**

- `test-levels-framework.md`
- `test-priorities-matrix.md`
- `ci-burn-in.md`

**Pact.js Utils (if enabled):**

- `pactjs-utils-overview.md`, `pactjs-utils-consumer-helpers.md`, `pactjs-utils-provider-verifier.md`, `pactjs-utils-request-filter.md`

**Contract Testing (if pactjs-utils disabled but relevant):**

- `contract-testing.md`

**Pact MCP (if tea_pact_mcp is "mcp"):**

- `pact-mcp.md`

---

## 6. Confirm Inputs

Summarize loaded inputs and confirm with the user. Then proceed.

---

## 7. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-01-preflight-and-context"]
  lastStep: "step-01-preflight-and-context"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-01-preflight-and-context'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-01-preflight-and-context'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section.

**Update `inputDocuments`**: Set `inputDocuments` in the output template frontmatter to the list of artifact paths loaded in this step (e.g., knowledge fragments, test design documents, configuration files).

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
