# Test Framework Setup - Validation Checklist

This checklist ensures the framework workflow completes successfully and all deliverables meet quality standards.

---

## Prerequisites

Before starting the workflow:

- [ ] Project root contains a valid project manifest (`package.json`, `pyproject.toml`, `pom.xml`, `build.gradle`, `go.mod`, `*.csproj`, `Gemfile`, or `Cargo.toml`)
- [ ] No existing test framework detected that conflicts with the target setup
- [ ] Project type identifiable (React, Vue, Angular, Next.js, Node, Python, Java, Go, .NET, Ruby, Rust, etc.)
- [ ] Bundler identifiable (Vite, Webpack, Rollup, esbuild) or not applicable (backend projects)
- [ ] User has write permissions to create directories and files

---

## Process Steps

### Step 1: Preflight Checks

- [ ] Stack type detected (`frontend`, `backend`, or `fullstack`)
- [ ] Project manifest successfully read and parsed (`package.json`, `pyproject.toml`, `pom.xml`, `go.mod`, etc.)
- [ ] Project type extracted correctly
- [ ] Bundler identified (or marked as N/A for backend projects)
- [ ] No framework conflicts detected
- [ ] Architecture documents located (if available)

### Step 2: Framework Selection

- [ ] Framework auto-detection logic executed
- [ ] Framework choice justified (Playwright vs Cypress for frontend; pytest/JUnit/Go test/xUnit/RSpec for backend)
- [ ] Framework preference respected (if explicitly set via `config.test_framework`)
- [ ] User notified of framework selection and rationale

### Step 3: Directory Structure

- [ ] `tests/` root directory created
- [ ] `tests/e2e/` directory created (or user's preferred structure)
- [ ] `tests/support/` directory created (critical pattern)
- [ ] `tests/support/fixtures/` directory created
- [ ] `tests/support/fixtures/factories/` directory created
- [ ] `tests/support/helpers/` directory created
- [ ] `tests/support/page-objects/` directory created (if applicable)
- [ ] All directories have correct permissions

**Note**: Test organization is flexible (e2e/, api/, integration/). The **support/** folder is the key pattern.

### Step 4: Configuration Files

- [ ] Framework config file created (`playwright.config.ts` or `cypress.config.ts`)
- [ ] Config file uses TypeScript (if `use_typescript: true`)
- [ ] Timeouts configured correctly (action: 15s, navigation: 30s, test: 60s)
- [ ] Base URL configured with environment variable fallback
- [ ] Trace/screenshot/video set to retain-on-failure
- [ ] Multiple reporters configured (HTML + JUnit + console)
- [ ] Parallel execution enabled
- [ ] CI-specific settings configured (retries, workers)
- [ ] Config file is syntactically valid (no compilation errors)

### Step 5: Environment Configuration

- [ ] `.env.example` created in project root
- [ ] `TEST_ENV` variable defined
- [ ] `BASE_URL` variable defined with default
- [ ] `API_URL` variable defined (if applicable)
- [ ] Authentication variables defined (if applicable)
- [ ] Feature flag variables defined (if applicable)
- [ ] `.nvmrc` created with appropriate Node version

### Step 6: Fixture Architecture

- [ ] `tests/support/fixtures/index.ts` created
- [ ] Base fixture extended from Playwright/Cypress
- [ ] Type definitions for fixtures created
- [ ] mergeTests pattern implemented (if multiple fixtures)
- [ ] Auto-cleanup logic included in fixtures
- [ ] Fixture architecture follows knowledge base patterns

### Step 7: Data Factories

- [ ] At least one factory created (e.g., UserFactory)
- [ ] Factories use @faker-js/faker for realistic data
- [ ] Factories track created entities (for cleanup)
- [ ] Factories implement `cleanup()` method
- [ ] Factories integrate with fixtures
- [ ] Factories follow knowledge base patterns

### Step 8: Sample Tests

- [ ] Example test file created (`tests/e2e/example.spec.ts`)
- [ ] Test uses fixture architecture
- [ ] Test demonstrates data factory usage
- [ ] Test uses proper selector strategy (data-testid)
- [ ] Test follows Given-When-Then structure
- [ ] Test includes proper assertions
- [ ] Network interception demonstrated (if applicable)

### Step 9: Helper Utilities

- [ ] API helper created (if API testing needed)
- [ ] Network helper created (if network mocking needed)
- [ ] Auth helper created (if authentication needed)
- [ ] Helpers follow functional patterns
- [ ] Helpers have proper error handling

### Step 10: Documentation

- [ ] `tests/README.md` created
- [ ] Setup instructions included
- [ ] Running tests section included
- [ ] Architecture overview section included
- [ ] Best practices section included
- [ ] CI integration section included
- [ ] Knowledge base references included
- [ ] Troubleshooting section included

### Step 11: Build & Test Script Updates

- [ ] Minimal test script added to appropriate config (`package.json` for frontend, `Makefile`/`pyproject.toml`/`build.gradle` for backend)
- [ ] Test framework dependency added (if not already present)
- [ ] Type definitions added (if TypeScript)
- [ ] Users can extend with additional scripts as needed

---

## Output Validation

### Configuration Validation

- [ ] Config file loads without errors
- [ ] Config file passes linting (if linter configured)
- [ ] Config file uses correct syntax for chosen framework
- [ ] All paths in config resolve correctly
- [ ] Reporter output directories exist or are created on test run

### Test Execution Validation

- [ ] Sample test runs successfully
- [ ] Test execution produces expected output (pass/fail)
- [ ] Test artifacts generated correctly (traces, screenshots, videos)
- [ ] Test report generated successfully
- [ ] No console errors or warnings during test run

### Directory Structure Validation

- [ ] All required directories exist
- [ ] Directory structure matches framework conventions
- [ ] No duplicate or conflicting directories
- [ ] Directories accessible with correct permissions

### File Integrity Validation

- [ ] All generated files are syntactically correct
- [ ] No placeholder text left in files (e.g., "TODO", "FIXME")
- [ ] All imports resolve correctly
- [ ] No hardcoded credentials or secrets in files
- [ ] All file paths use correct separators for OS

---

## Quality Checks

### Code Quality

- [ ] Generated code follows project coding standards
- [ ] TypeScript types are complete and accurate (no `any` unless necessary)
- [ ] No unused imports or variables
- [ ] Consistent code formatting (matches project style)
- [ ] No linting errors in generated files

### Best Practices Compliance

- [ ] Fixture architecture follows pure function → fixture → mergeTests pattern
- [ ] Data factories implement auto-cleanup
- [ ] Network interception occurs before navigation
- [ ] Selectors use data-testid strategy
- [ ] Artifacts only captured on failure
- [ ] Tests follow Given-When-Then structure
- [ ] No hard-coded waits or sleeps

### Knowledge Base Alignment

- [ ] Fixture pattern matches `fixture-architecture.md`
- [ ] Data factories match `data-factories.md`
- [ ] Network handling matches `network-first.md`
- [ ] Config follows `playwright-config.md` or `test-config.md`
- [ ] Test quality matches `test-quality.md`

### Pact Consumer CDC Alignment (when `tea_use_pactjs_utils` enabled)

- [ ] `vitest.config.pact.ts` is minimal (no pool/coverage/setup copied from unit config)
- [ ] Script names match pactjs-utils (`test:pact:consumer`, `publish:pact`, `can:i:deploy:consumer`, `record:consumer:deployment`)
- [ ] Scripts source `env-setup.sh` inline in package.json
- [ ] Shell scripts use `pact-broker` not `npx pact-broker`
- [ ] Shell scripts use `PACTICIPANT` env var pattern (not hardcoded service names)
- [ ] `can-i-deploy.sh` has `--retry-while-unknown=10 --retry-interval=30`
- [ ] `record-deployment.sh` has branch guard (only records on main/master)
- [ ] `env-setup.sh` uses `set -eu`; broker scripts use `set -euo pipefail` — each with explanatory comment
- [ ] CI workflow named `contract-test-consumer.yml`
- [ ] CI has workflow-level env block (not per-step)
- [ ] CI has `detect-breaking-change` step before install
- [ ] CI step numbering skips (3) — webhook-triggered provider verification
- [ ] CI can-i-deploy has `PACT_BREAKING_CHANGE != 'true'` condition
- [ ] CI has NO upload-artifact step (broker is source of truth)
- [ ] `.github/actions/detect-breaking-change/action.yml` exists
- [ ] Consumer tests use `.pacttest.ts` extension
- [ ] Consumer tests use PactV4 `addInteraction()` builder (not PactV3 fluent API)
- [ ] Consumer tests call REAL consumer code (actual API client functions), NOT raw `fetch()`
- [ ] Consumer code exposes URL injection mechanism (`setApiUrl()`, env var, or constructor param)
- [ ] Local consumer-helpers shim present if `@seontechnologies/pactjs-utils` not installed
- [ ] `.gitignore` includes `/pacts/` and `pact-logs/`

### Security Checks

- [ ] No credentials in configuration files
- [ ] .env.example contains placeholders, not real values
- [ ] Sensitive test data handled securely
- [ ] API keys and tokens use environment variables
- [ ] No secrets committed to version control

---

## Integration Points

### Status File Integration

- [ ] Framework initialization logged in Quality & Testing Progress section
- [ ] Status file updated with completion timestamp
- [ ] Status file shows framework: Playwright or Cypress

### Knowledge Base Integration

- [ ] Relevant knowledge fragments identified from tea-index.csv
- [ ] Knowledge fragments successfully loaded
- [ ] Patterns from knowledge base applied correctly
- [ ] Knowledge base references included in documentation

### Workflow Dependencies

- [ ] Can proceed to `ci` workflow after completion
- [ ] Can proceed to `test-design` workflow after completion
- [ ] Can proceed to `atdd` workflow after completion
- [ ] Framework setup compatible with downstream workflows

---

## Completion Criteria

**All of the following must be true:**

- [ ] All prerequisite checks passed
- [ ] All process steps completed without errors
- [ ] All output validations passed
- [ ] All quality checks passed
- [ ] All integration points verified
- [ ] Sample test executes successfully
- [ ] User can run the appropriate test command without errors (`npm run test:e2e`, `pytest`, `go test ./...`, etc.)
- [ ] Documentation is complete and accurate
- [ ] No critical issues or blockers identified

---

## Post-Workflow Actions

**User must complete:**

1. [ ] Copy `.env.example` to `.env`
2. [ ] Fill in environment-specific values in `.env`
3. [ ] Run `npm install` to install test dependencies
4. [ ] Run `npm run test:e2e` to verify setup
5. [ ] Review `tests/README.md` for project-specific guidance

**Recommended next workflows:**

1. [ ] Run `ci` workflow to set up CI/CD pipeline
2. [ ] Run `test-design` workflow to plan test coverage
3. [ ] Run `atdd` workflow when ready to develop stories

---

## Rollback Procedure

If workflow fails and needs to be rolled back:

1. [ ] Delete `tests/` directory
2. [ ] Remove test scripts from package.json
3. [ ] Delete `.env.example` (if created)
4. [ ] Delete `.nvmrc` (if created)
5. [ ] Delete framework config file
6. [ ] Remove test dependencies from package.json (if added)
7. [ ] Run `npm install` to clean up node_modules

---

## Notes

### Common Issues

**Issue**: Config file has TypeScript errors

- **Solution**: Ensure `@playwright/test` or `cypress` types are installed

**Issue**: Sample test fails to run

- **Solution**: Check BASE_URL in .env, ensure app is running

**Issue**: Fixture cleanup not working

- **Solution**: Verify cleanup() is called in fixture teardown

**Issue**: Network interception not working

- **Solution**: Ensure route setup occurs before page.goto()

### Framework-Specific Considerations

**Playwright:**

- Requires Node.js 18+
- Browser binaries auto-installed on first run
- Trace viewer requires running `npx playwright show-trace`

**Cypress:**

- Requires Node.js 18+
- Cypress app opens on first run
- Component testing requires additional setup

### Version Compatibility

- [ ] Node.js version matches .nvmrc
- [ ] Framework version compatible with Node.js version
- [ ] TypeScript version compatible with framework
- [ ] All peer dependencies satisfied

---

**Checklist Complete**: Sign off when all items checked and validated.

**Completed by:** {name}
**Date:** {date}
**Framework:** { Playwright / Cypress or something else}
**Notes:** {notes}
