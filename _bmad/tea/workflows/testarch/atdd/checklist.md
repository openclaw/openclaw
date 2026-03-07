# ATDD Workflow Validation Checklist

Use this checklist to validate that the ATDD workflow has been executed correctly and all deliverables meet quality standards.

## Prerequisites

Before starting this workflow, verify:

- [ ] Story approved with clear acceptance criteria (AC must be testable)
- [ ] Development sandbox/environment ready
- [ ] Framework scaffolding exists (run `framework` workflow if missing)
- [ ] Test framework configuration available (playwright.config.ts or cypress.config.ts)
- [ ] Package.json has test dependencies installed (Playwright or Cypress)

**Halt if missing:** Framework scaffolding or story acceptance criteria

---

## Step 1: Story Context and Requirements

- [ ] Story markdown file loaded and parsed successfully
- [ ] All acceptance criteria identified and extracted
- [ ] Affected systems and components identified
- [ ] Technical constraints documented
- [ ] Framework configuration loaded (playwright.config.ts or cypress.config.ts)
- [ ] Test directory structure identified from config
- [ ] Existing fixture patterns reviewed for consistency
- [ ] Similar test patterns searched and found in `{test_dir}`
- [ ] Knowledge base fragments loaded:
  - [ ] `fixture-architecture.md`
  - [ ] `data-factories.md`
  - [ ] `component-tdd.md`
  - [ ] `network-first.md`
  - [ ] `test-quality.md`

---

## Step 2: Test Level Selection and Strategy

- [ ] Each acceptance criterion analyzed for appropriate test level
- [ ] Test level selection framework applied (E2E vs API vs Component vs Unit)
- [ ] E2E tests: Critical user journeys and multi-system integration identified
- [ ] API tests: Business logic and service contracts identified
- [ ] Component tests: UI component behavior and interactions identified
- [ ] Unit tests: Pure logic and edge cases identified (if applicable)
- [ ] Duplicate coverage avoided (same behavior not tested at multiple levels unnecessarily)
- [ ] Tests prioritized using P0-P3 framework (if test-design document exists)
- [ ] Primary test level set in `primary_level` variable (typically E2E or API)
- [ ] Test levels documented in ATDD checklist

---

## Step 3: Failing Tests Generated

### Test File Structure Created

- [ ] Test files organized in appropriate directories:
  - [ ] `tests/e2e/` for end-to-end tests
  - [ ] `tests/api/` for API tests
  - [ ] `tests/component/` for component tests
  - [ ] `tests/support/` for infrastructure (fixtures, factories, helpers)

### E2E Tests (If Applicable)

- [ ] E2E test files created in `tests/e2e/`
- [ ] All tests follow Given-When-Then format
- [ ] Tests use `data-testid` selectors (not CSS classes or fragile selectors)
- [ ] One assertion per test (atomic test design)
- [ ] No hard waits or sleeps (explicit waits only)
- [ ] Network-first pattern applied (route interception BEFORE navigation)
- [ ] Tests fail initially (RED phase verified by local test run)
- [ ] Failure messages are clear and actionable

### API Tests (If Applicable)

- [ ] API test files created in `tests/api/`
- [ ] Tests follow Given-When-Then format
- [ ] API contracts validated (request/response structure)
- [ ] HTTP status codes verified
- [ ] Response body validation includes all required fields
- [ ] Error cases tested (400, 401, 403, 404, 500)
- [ ] Tests fail initially (RED phase verified)

### Component Tests (If Applicable)

- [ ] Component test files created in `tests/component/`
- [ ] Tests follow Given-When-Then format
- [ ] Component mounting works correctly
- [ ] Interaction testing covers user actions (click, hover, keyboard)
- [ ] State management within component validated
- [ ] Props and events tested
- [ ] Tests fail initially (RED phase verified)

### Test Quality Validation

- [ ] All tests use Given-When-Then structure with clear comments
- [ ] All tests have descriptive names explaining what they test
- [ ] No duplicate tests (same behavior tested multiple times)
- [ ] No flaky patterns (race conditions, timing issues)
- [ ] No test interdependencies (tests can run in any order)
- [ ] Tests are deterministic (same input always produces same result)

---

## Step 4: Data Infrastructure Built

### Data Factories Created

- [ ] Factory files created in `tests/support/factories/`
- [ ] All factories use `@faker-js/faker` for random data generation (no hardcoded values)
- [ ] Factories support overrides for specific test scenarios
- [ ] Factories generate complete valid objects matching API contracts
- [ ] Helper functions for bulk creation provided (e.g., `createUsers(count)`)
- [ ] Factory exports are properly typed (TypeScript)

### Test Fixtures Created

- [ ] Fixture files created in `tests/support/fixtures/`
- [ ] All fixtures use Playwright's `test.extend()` pattern
- [ ] Fixtures have setup phase (arrange test preconditions)
- [ ] Fixtures provide data to tests via `await use(data)`
- [ ] Fixtures have teardown phase with auto-cleanup (delete created data)
- [ ] Fixtures are composable (can use other fixtures if needed)
- [ ] Fixtures are isolated (each test gets fresh data)
- [ ] Fixtures are type-safe (TypeScript types defined)

### Mock Requirements Documented

- [ ] External service mocking requirements identified
- [ ] Mock endpoints documented with URLs and methods
- [ ] Success response examples provided
- [ ] Failure response examples provided
- [ ] Mock requirements documented in ATDD checklist for DEV team

### data-testid Requirements Listed

- [ ] All required data-testid attributes identified from E2E tests
- [ ] data-testid list organized by page or component
- [ ] Each data-testid has clear description of element it targets
- [ ] data-testid list included in ATDD checklist for DEV team

---

## Step 5: Implementation Checklist Created

- [ ] Implementation checklist created with clear structure
- [ ] Each failing test mapped to concrete implementation tasks
- [ ] Tasks include:
  - [ ] Route/component creation
  - [ ] Business logic implementation
  - [ ] API integration
  - [ ] data-testid attribute additions
  - [ ] Error handling
  - [ ] Test execution command
  - [ ] Completion checkbox
- [ ] Red-Green-Refactor workflow documented in checklist
- [ ] RED phase marked as complete (TEA responsibility)
- [ ] GREEN phase tasks listed for DEV team
- [ ] REFACTOR phase guidance provided
- [ ] Execution commands provided:
  - [ ] Run all tests: `npm run test:e2e`
  - [ ] Run specific test file
  - [ ] Run in headed mode
  - [ ] Debug specific test
- [ ] Estimated effort included (hours or story points)

---

## Step 6: Deliverables Generated

### ATDD Checklist Document Created

- [ ] Output file created at `{test_artifacts}/atdd-checklist-{story_id}.md`
- [ ] Document follows template structure from `atdd-checklist-template.md`
- [ ] Document includes all required sections:
  - [ ] Story summary
  - [ ] Acceptance criteria breakdown
  - [ ] Failing tests created (paths and line counts)
  - [ ] Data factories created
  - [ ] Fixtures created
  - [ ] Mock requirements
  - [ ] Required data-testid attributes
  - [ ] Implementation checklist
  - [ ] Red-green-refactor workflow
  - [ ] Execution commands
  - [ ] Next steps for DEV team
- [ ] Output shared with DEV workflow (manual handoff; not auto-consumed)

### All Tests Verified to Fail (RED Phase)

- [ ] Full test suite run locally before finalizing
- [ ] All tests fail as expected (RED phase confirmed)
- [ ] No tests passing before implementation (if passing, test is invalid)
- [ ] Failure messages documented in ATDD checklist
- [ ] Failures are due to missing implementation, not test bugs
- [ ] Test run output captured for reference

### Summary Provided

- [ ] Summary includes:
  - [ ] Story ID
  - [ ] Primary test level
  - [ ] Test counts (E2E, API, Component)
  - [ ] Test file paths
  - [ ] Factory count
  - [ ] Fixture count
  - [ ] Mock requirements count
  - [ ] data-testid count
  - [ ] Implementation task count
  - [ ] Estimated effort
  - [ ] Next steps for DEV team
  - [ ] Output file path
  - [ ] Knowledge base references applied

---

## Quality Checks

### Test Design Quality

- [ ] Tests are readable (clear Given-When-Then structure)
- [ ] Tests are maintainable (use factories and fixtures, not hardcoded data)
- [ ] Tests are isolated (no shared state between tests)
- [ ] Tests are deterministic (no race conditions or flaky patterns)
- [ ] Tests are atomic (one assertion per test)
- [ ] Tests are fast (no unnecessary waits or delays)

### Knowledge Base Integration

- [ ] fixture-architecture.md patterns applied to all fixtures
- [ ] data-factories.md patterns applied to all factories
- [ ] network-first.md patterns applied to E2E tests with network requests
- [ ] component-tdd.md patterns applied to component tests
- [ ] test-quality.md principles applied to all test design

### Code Quality

- [ ] All TypeScript types are correct and complete
- [ ] No linting errors in generated test files
- [ ] Consistent naming conventions followed
- [ ] Imports are organized and correct
- [ ] Code follows project style guide

---

## Integration Points

### With DEV Agent

- [ ] ATDD checklist provides clear implementation guidance
- [ ] Implementation tasks are granular and actionable
- [ ] data-testid requirements are complete and clear
- [ ] Mock requirements include all necessary details
- [ ] Execution commands work correctly

### With Story Workflow

- [ ] Story ID correctly referenced in output files
- [ ] Acceptance criteria from story accurately reflected in tests
- [ ] Technical constraints from story considered in test design

### With Framework Workflow

- [ ] Test framework configuration correctly detected and used
- [ ] Directory structure matches framework setup
- [ ] Fixtures and helpers follow established patterns
- [ ] Naming conventions consistent with framework standards

### With test-design Workflow (If Available)

- [ ] P0 scenarios from test-design prioritized in ATDD
- [ ] Risk assessment from test-design considered in test coverage
- [ ] Coverage strategy from test-design aligned with ATDD tests

---

## Completion Criteria

All of the following must be true before marking this workflow as complete:

- [ ] **Story acceptance criteria analyzed** and mapped to appropriate test levels
- [ ] **Failing tests created** at all appropriate levels (E2E, API, Component)
- [ ] **Given-When-Then format** used consistently across all tests
- [ ] **RED phase verified** by local test run (all tests failing as expected)
- [ ] **Network-first pattern** applied to E2E tests with network requests
- [ ] **Data factories created** using faker (no hardcoded test data)
- [ ] **Fixtures created** with auto-cleanup in teardown
- [ ] **Mock requirements documented** for external services
- [ ] **data-testid attributes listed** for DEV team
- [ ] **Implementation checklist created** mapping tests to code tasks
- [ ] **Red-green-refactor workflow documented** in ATDD checklist
- [ ] **Execution commands provided** and verified to work
- [ ] **ATDD checklist document created** and saved to correct location
- [ ] **Output file formatted correctly** using template structure
- [ ] **Knowledge base references applied** and documented in summary
- [ ] **No test quality issues** (flaky patterns, race conditions, hardcoded data)

---

## Common Issues and Resolutions

### Issue: Tests pass before implementation

**Problem:** A test passes even though no implementation code exists yet.

**Resolution:**

- Review test to ensure it's testing actual behavior, not mocked/stubbed behavior
- Check if test is accidentally using existing functionality
- Verify test assertions are correct and meaningful
- Rewrite test to fail until implementation is complete

### Issue: Network-first pattern not applied

**Problem:** Route interception happens after navigation, causing race conditions.

**Resolution:**

- Move `await page.route()` calls BEFORE `await page.goto()`
- Review `network-first.md` knowledge fragment
- Update all E2E tests to follow network-first pattern

### Issue: Hardcoded test data in tests

**Problem:** Tests use hardcoded strings/numbers instead of factories.

**Resolution:**

- Replace all hardcoded data with factory function calls
- Use `faker` for all random data generation
- Update data-factories to support all required test scenarios

### Issue: Fixtures missing auto-cleanup

**Problem:** Fixtures create data but don't clean it up in teardown.

**Resolution:**

- Add cleanup logic after `await use(data)` in fixture
- Call deletion/cleanup functions in teardown
- Verify cleanup works by checking database/storage after test run

### Issue: Tests have multiple assertions

**Problem:** Tests verify multiple behaviors in single test (not atomic).

**Resolution:**

- Split into separate tests (one assertion per test)
- Each test should verify exactly one behavior
- Use descriptive test names to clarify what each test verifies

### Issue: Tests depend on execution order

**Problem:** Tests fail when run in isolation or different order.

**Resolution:**

- Remove shared state between tests
- Each test should create its own test data
- Use fixtures for consistent setup across tests
- Verify tests can run with `.only` flag

---

## Notes for TEA Agent

- **Preflight halt is critical:** Do not proceed if story has no acceptance criteria or framework is missing
- **RED phase verification is mandatory:** Tests must fail before sharing with DEV team
- **Network-first pattern:** Route interception BEFORE navigation prevents race conditions
- **One assertion per test:** Atomic tests provide clear failure diagnosis
- **Auto-cleanup is non-negotiable:** Every fixture must clean up data in teardown
- **Use knowledge base:** Load relevant fragments (fixture-architecture, data-factories, network-first, component-tdd, test-quality) for guidance
- **Share with DEV agent:** ATDD checklist provides implementation roadmap from red to green
