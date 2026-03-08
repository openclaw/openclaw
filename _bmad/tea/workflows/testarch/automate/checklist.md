# Automate Workflow Validation Checklist

Use this checklist to validate that the automate workflow has been executed correctly and all deliverables meet quality standards.

## Prerequisites

Before starting this workflow, verify:

- [ ] Framework scaffolding configured (playwright.config.ts or cypress.config.ts exists)
- [ ] Test directory structure exists (tests/ folder with subdirectories)
- [ ] Package.json has test framework dependencies installed

**Halt only if:** Framework scaffolding is completely missing (run `framework` workflow first)

**Note:** BMad artifacts (story, tech-spec, PRD) are OPTIONAL - workflow can run without them
**Note:** `automate` generates tests; it does not run `*atdd` or `*test-review`. If ATDD outputs exist, use them as input and avoid duplicate coverage.

---

## Step 1: Execution Mode Determination and Context Loading

### Mode Detection

- [ ] Execution mode correctly determined:
  - [ ] BMad-Integrated Mode (story_file variable set) OR
  - [ ] Standalone Mode (target_feature or target_files set) OR
  - [ ] Auto-discover Mode (no targets specified)

### BMad Artifacts (If Available - OPTIONAL)

- [ ] Story markdown loaded (if `{story_file}` provided)
- [ ] Acceptance criteria extracted from story (if available)
- [ ] Tech-spec.md loaded (if `{use_tech_spec}` true and file exists)
- [ ] Test-design.md loaded (if `{use_test_design}` true and file exists)
- [ ] PRD.md loaded (if `{use_prd}` true and file exists)
- [ ] **Note**: Absence of BMad artifacts does NOT halt workflow

### Framework Configuration

- [ ] Test framework config loaded (playwright.config.ts or cypress.config.ts)
- [ ] Test directory structure identified from `{test_dir}`
- [ ] Existing test patterns reviewed
- [ ] Test runner capabilities noted (parallel execution, fixtures, etc.)

### Coverage Analysis

- [ ] Existing test files searched in `{test_dir}` (if `{analyze_coverage}` true)
- [ ] Tested features vs untested features identified
- [ ] Coverage gaps mapped (tests to source files)
- [ ] Existing fixture and factory patterns checked

### Knowledge Base Fragments Loaded

- [ ] `test-levels-framework.md` - Test level selection
- [ ] `test-priorities.md` - Priority classification (P0-P3)
- [ ] `fixture-architecture.md` - Fixture patterns with auto-cleanup
- [ ] `data-factories.md` - Factory patterns using faker
- [ ] `selective-testing.md` - Targeted test execution strategies
- [ ] `ci-burn-in.md` - Flaky test detection patterns
- [ ] `test-quality.md` - Test design principles

---

## Step 2: Automation Targets Identification

### Target Determination

**BMad-Integrated Mode (if story available):**

- [ ] Acceptance criteria mapped to test scenarios
- [ ] Features implemented in story identified
- [ ] Existing ATDD tests checked (if any)
- [ ] Expansion beyond ATDD planned (edge cases, negative paths)

**Standalone Mode (if no story):**

- [ ] Specific feature analyzed (if `{target_feature}` specified)
- [ ] Specific files analyzed (if `{target_files}` specified)
- [ ] Features auto-discovered (if `{auto_discover_features}` true)
- [ ] Features prioritized by:
  - [ ] No test coverage (highest priority)
  - [ ] Complex business logic
  - [ ] External integrations (API, database, auth)
  - [ ] Critical user paths (login, checkout, etc.)

### Test Level Selection

- [ ] Test level selection framework applied (from `test-levels-framework.md`)
- [ ] E2E tests identified: Critical user journeys, multi-system integration
- [ ] API tests identified: Business logic, service contracts, data transformations
- [ ] Component tests identified: UI behavior, interactions, state management
- [ ] Unit tests identified: Pure logic, edge cases, error handling

### Duplicate Coverage Avoidance

- [ ] Same behavior NOT tested at multiple levels unnecessarily
- [ ] E2E used for critical happy path only
- [ ] API tests used for business logic variations
- [ ] Component tests used for UI interaction edge cases
- [ ] Unit tests used for pure logic edge cases

### Priority Assignment

- [ ] Test priorities assigned using `test-priorities.md` framework
- [ ] P0 tests: Critical paths, security-critical, data integrity
- [ ] P1 tests: Important features, integration points, error handling
- [ ] P2 tests: Edge cases, less-critical variations, performance
- [ ] P3 tests: Nice-to-have, rarely-used features, exploratory
- [ ] Priority variables respected:
  - [ ] `{include_p0}` = true (always include)
  - [ ] `{include_p1}` = true (high priority)
  - [ ] `{include_p2}` = true (medium priority)
  - [ ] `{include_p3}` = false (low priority, skip by default)

### Coverage Plan Created

- [ ] Test coverage plan documented
- [ ] What will be tested at each level listed
- [ ] Priorities assigned to each test
- [ ] Coverage strategy clear (critical-paths, comprehensive, or selective)

---

## Step 3: Test Infrastructure Generated

### Fixture Architecture

- [ ] Existing fixtures checked in `tests/support/fixtures/`
- [ ] Fixture architecture created/enhanced (if `{generate_fixtures}` true)
- [ ] All fixtures use Playwright's `test.extend()` pattern
- [ ] All fixtures have auto-cleanup in teardown
- [ ] Common fixtures created/enhanced:
  - [ ] authenticatedUser (with auto-delete)
  - [ ] apiRequest (authenticated client)
  - [ ] mockNetwork (external service mocking)
  - [ ] testDatabase (with auto-cleanup)

### Data Factories

- [ ] Existing factories checked in `tests/support/factories/`
- [ ] Factory architecture created/enhanced (if `{generate_factories}` true)
- [ ] All factories use `@faker-js/faker` for random data (no hardcoded values)
- [ ] All factories support overrides for specific scenarios
- [ ] Common factories created/enhanced:
  - [ ] User factory (email, password, name, role)
  - [ ] Product factory (name, price, SKU)
  - [ ] Order factory (items, total, status)
- [ ] Cleanup helpers provided (e.g., deleteUser(), deleteProduct())

### Helper Utilities

- [ ] Existing helpers checked in `tests/support/helpers/` (if `{update_helpers}` true)
- [ ] Common utilities created/enhanced:
  - [ ] waitFor (polling for complex conditions)
  - [ ] retry (retry helper for flaky operations)
  - [ ] testData (test data generation)
  - [ ] assertions (custom assertion helpers)

---

## Step 4: Test Files Generated

### Test File Structure

- [ ] Test files organized correctly:
  - [ ] `tests/e2e/` for E2E tests
  - [ ] `tests/api/` for API tests
  - [ ] `tests/component/` for component tests
  - [ ] `tests/unit/` for unit tests
  - [ ] `tests/support/` for fixtures/factories/helpers

### E2E Tests (If Applicable)

- [ ] E2E test files created in `tests/e2e/`
- [ ] All tests follow Given-When-Then format
- [ ] All tests have priority tags ([P0], [P1], [P2], [P3]) in test name
- [ ] All tests use data-testid selectors (not CSS classes)
- [ ] One assertion per test (atomic design)
- [ ] No hard waits or sleeps (explicit waits only)
- [ ] Network-first pattern applied (route interception BEFORE navigation)
- [ ] Clear Given-When-Then comments in test code

### API Tests (If Applicable)

- [ ] API test files created in `tests/api/`
- [ ] All tests follow Given-When-Then format
- [ ] All tests have priority tags in test name
- [ ] API contracts validated (request/response structure)
- [ ] HTTP status codes verified
- [ ] Response body validation includes required fields
- [ ] Error cases tested (400, 401, 403, 404, 500)
- [ ] JWT token format validated (if auth tests)

### Component Tests (If Applicable)

- [ ] Component test files created in `tests/component/`
- [ ] All tests follow Given-When-Then format
- [ ] All tests have priority tags in test name
- [ ] Component mounting works correctly
- [ ] Interaction testing covers user actions (click, hover, keyboard)
- [ ] State management validated
- [ ] Props and events tested

### Unit Tests (If Applicable)

- [ ] Unit test files created in `tests/unit/`
- [ ] All tests follow Given-When-Then format
- [ ] All tests have priority tags in test name
- [ ] Pure logic tested (no dependencies)
- [ ] Edge cases covered
- [ ] Error handling tested

### Quality Standards Enforced

- [ ] All tests use Given-When-Then format with clear comments
- [ ] All tests have descriptive names with priority tags
- [ ] No duplicate tests (same behavior tested multiple times)
- [ ] No flaky patterns (race conditions, timing issues)
- [ ] No test interdependencies (tests can run in any order)
- [ ] Tests are deterministic (same input always produces same result)
- [ ] All tests use data-testid selectors (E2E tests)
- [ ] No hard waits: `await page.waitForTimeout()` (forbidden)
- [ ] No conditional flow: `if (await element.isVisible())` (forbidden)
- [ ] No try-catch for test logic (only for cleanup)
- [ ] No hardcoded test data (use factories with faker)
- [ ] No page object classes (tests are direct and simple)
- [ ] No shared state between tests

### Network-First Pattern Applied

- [ ] Route interception set up BEFORE navigation (E2E tests with network requests)
- [ ] `page.route()` called before `page.goto()` to prevent race conditions
- [ ] Network-first pattern verified in all E2E tests that make API calls

---

## Step 5: Test Validation and Healing (NEW - Phase 2.5)

### Healing Configuration

- [ ] Healing configuration checked:
  - [ ] `{auto_validate}` setting noted (default: true)
  - [ ] `{auto_heal_failures}` setting noted (default: false)
  - [ ] `{max_healing_iterations}` setting noted (default: 3)
  - [ ] `{use_mcp_healing}` setting noted (default: true)

### Healing Knowledge Fragments Loaded (If Healing Enabled)

- [ ] `test-healing-patterns.md` loaded (common failure patterns and fixes)
- [ ] `selector-resilience.md` loaded (selector refactoring guide)
- [ ] `timing-debugging.md` loaded (race condition fixes)

### Test Execution and Validation

- [ ] Generated tests executed (if `{auto_validate}` true)
- [ ] Test results captured:
  - [ ] Total tests run
  - [ ] Passing tests count
  - [ ] Failing tests count
  - [ ] Error messages and stack traces captured

### Healing Loop (If Enabled and Tests Failed)

- [ ] Healing loop entered (if `{auto_heal_failures}` true AND tests failed)
- [ ] For each failing test:
  - [ ] Failure pattern identified (selector, timing, data, network, hard wait)
  - [ ] Appropriate healing strategy applied:
    - [ ] Stale selector → Replaced with data-testid or ARIA role
    - [ ] Race condition → Added network-first interception or state waits
    - [ ] Dynamic data → Replaced hardcoded values with regex/dynamic generation
    - [ ] Network error → Added route mocking
    - [ ] Hard wait → Replaced with event-based wait
  - [ ] Healed test re-run to validate fix
  - [ ] Iteration count tracked (max 3 attempts)

### Unfixable Tests Handling

- [ ] Tests that couldn't be healed after 3 iterations marked with `test.fixme()` (if `{mark_unhealable_as_fixme}` true)
- [ ] Detailed comment added to test.fixme() tests:
  - [ ] What failure occurred
  - [ ] What healing was attempted (3 iterations)
  - [ ] Why healing failed
  - [ ] Manual investigation steps needed
- [ ] Original test logic preserved in comments

### Healing Report Generated

- [ ] Healing report generated (if healing attempted)
- [ ] Report includes:
  - [ ] Auto-heal enabled status
  - [ ] Healing mode (MCP-assisted or Pattern-based)
  - [ ] Iterations allowed (max_healing_iterations)
  - [ ] Validation results (total, passing, failing)
  - [ ] Successfully healed tests (count, file:line, fix applied)
  - [ ] Unable to heal tests (count, file:line, reason)
  - [ ] Healing patterns applied (selector fixes, timing fixes, data fixes)
  - [ ] Knowledge base references used

---

## Step 6: Documentation and Scripts Updated

### Test README Updated

- [ ] `tests/README.md` created or updated (if `{update_readme}` true)
- [ ] Test suite structure overview included
- [ ] Test execution instructions provided (all, specific files, by priority)
- [ ] Fixture usage examples provided
- [ ] Factory usage examples provided
- [ ] Priority tagging convention explained ([P0], [P1], [P2], [P3])
- [ ] How to write new tests documented
- [ ] Common patterns documented
- [ ] Anti-patterns documented (what to avoid)

### package.json Scripts Updated

- [ ] package.json scripts added/updated (if `{update_package_scripts}` true)
- [ ] `test:e2e` script for all E2E tests
- [ ] `test:e2e:p0` script for P0 tests only
- [ ] `test:e2e:p1` script for P0 + P1 tests
- [ ] `test:api` script for API tests
- [ ] `test:component` script for component tests
- [ ] `test:unit` script for unit tests (if applicable)

### Test Suite Executed

- [ ] Test suite run locally (if `{run_tests_after_generation}` true)
- [ ] Test results captured (passing/failing counts)
- [ ] No flaky patterns detected (tests are deterministic)
- [ ] Setup requirements documented (if any)
- [ ] Known issues documented (if any)

---

## Step 6: Automation Summary Generated

### Automation Summary Document

- [ ] Output file created at `{output_summary}`
- [ ] Document includes execution mode (BMad-Integrated, Standalone, Auto-discover)
- [ ] Feature analysis included (source files, coverage gaps) - Standalone mode
- [ ] Tests created listed (E2E, API, Component, Unit) with counts and paths
- [ ] Infrastructure created listed (fixtures, factories, helpers)
- [ ] Test execution instructions provided
- [ ] Coverage analysis included:
  - [ ] Total test count
  - [ ] Priority breakdown (P0, P1, P2, P3 counts)
  - [ ] Test level breakdown (E2E, API, Component, Unit counts)
  - [ ] Coverage percentage (if calculated)
  - [ ] Coverage status (acceptance criteria covered, gaps identified)
- [ ] Definition of Done checklist included
- [ ] Next steps provided
- [ ] Recommendations included (if Standalone mode)

### Summary Provided to User

- [ ] Concise summary output provided
- [ ] Total tests created across test levels
- [ ] Priority breakdown (P0, P1, P2, P3 counts)
- [ ] Infrastructure counts (fixtures, factories, helpers)
- [ ] Test execution command provided
- [ ] Output file path provided
- [ ] Next steps listed

---

## Quality Checks

### Test Design Quality

- [ ] Tests are readable (clear Given-When-Then structure)
- [ ] Tests are maintainable (use factories/fixtures, not hardcoded data)
- [ ] Tests are isolated (no shared state between tests)
- [ ] Tests are deterministic (no race conditions or flaky patterns)
- [ ] Tests are atomic (one assertion per test)
- [ ] Tests are fast (no unnecessary waits or delays)
- [ ] Tests are lean (files under {max_file_lines} lines)

### Knowledge Base Integration

- [ ] Test level selection framework applied (from `test-levels-framework.md`)
- [ ] Priority classification applied (from `test-priorities.md`)
- [ ] Fixture architecture patterns applied (from `fixture-architecture.md`)
- [ ] Data factory patterns applied (from `data-factories.md`)
- [ ] Selective testing strategies considered (from `selective-testing.md`)
- [ ] Flaky test detection patterns considered (from `ci-burn-in.md`)
- [ ] Test quality principles applied (from `test-quality.md`)

### Code Quality

- [ ] All TypeScript types are correct and complete
- [ ] No linting errors in generated test files
- [ ] Consistent naming conventions followed
- [ ] Imports are organized and correct
- [ ] Code follows project style guide
- [ ] No console.log or debug statements in test code

---

## Integration Points

### With Framework Workflow

- [ ] Test framework configuration detected and used
- [ ] Directory structure matches framework setup
- [ ] Fixtures and helpers follow established patterns
- [ ] Naming conventions consistent with framework standards

### With BMad Workflows (If Available - OPTIONAL)

**With Story Workflow:**

- [ ] Story ID correctly referenced in output (if story available)
- [ ] Acceptance criteria from story reflected in tests (if story available)
- [ ] Technical constraints from story considered (if story available)

**With test-design Workflow:**

- [ ] P0 scenarios from test-design prioritized (if test-design available)
- [ ] Risk assessment from test-design considered (if test-design available)
- [ ] Coverage strategy aligned with test-design (if test-design available)

**With atdd Workflow:**

- [ ] ATDD artifacts provided or located (manual handoff; `atdd` not auto-run)
- [ ] Existing ATDD tests checked (if story had ATDD workflow run)
- [ ] Expansion beyond ATDD planned (edge cases, negative paths)
- [ ] No duplicate coverage with ATDD tests

### With CI Pipeline

- [ ] Tests can run in CI environment
- [ ] Tests are parallelizable (no shared state)
- [ ] Tests have appropriate timeouts
- [ ] Tests clean up their data (no CI environment pollution)

---

## Completion Criteria

All of the following must be true before marking this workflow as complete:

- [ ] **Execution mode determined** (BMad-Integrated, Standalone, or Auto-discover)
- [ ] **Framework configuration loaded** and validated
- [ ] **Coverage analysis completed** (gaps identified if analyze_coverage true)
- [ ] **Automation targets identified** (what needs testing)
- [ ] **Test levels selected** appropriately (E2E, API, Component, Unit)
- [ ] **Duplicate coverage avoided** (same behavior not tested at multiple levels)
- [ ] **Test priorities assigned** (P0, P1, P2, P3)
- [ ] **Fixture architecture created/enhanced** with auto-cleanup
- [ ] **Data factories created/enhanced** using faker (no hardcoded data)
- [ ] **Helper utilities created/enhanced** (if needed)
- [ ] **Test files generated** at appropriate levels (E2E, API, Component, Unit)
- [ ] **Given-When-Then format used** consistently across all tests
- [ ] **Priority tags added** to all test names ([P0], [P1], [P2], [P3])
- [ ] **data-testid selectors used** in E2E tests (not CSS classes)
- [ ] **Network-first pattern applied** (route interception before navigation)
- [ ] **Quality standards enforced** (no hard waits, no flaky patterns, self-cleaning, deterministic)
- [ ] **Test README updated** with execution instructions and patterns
- [ ] **package.json scripts updated** with test execution commands
- [ ] **Test suite run locally** (if run_tests_after_generation true)
- [ ] **Tests validated** (if auto_validate enabled)
- [ ] **Failures healed** (if auto_heal_failures enabled and tests failed)
- [ ] **Healing report generated** (if healing attempted)
- [ ] **Unfixable tests marked** with test.fixme() and detailed comments (if any)
- [ ] **Automation summary created** and saved to correct location
- [ ] **Output file formatted correctly**
- [ ] **Knowledge base references applied** and documented (including healing fragments if used)
- [ ] **No test quality issues** (flaky patterns, race conditions, hardcoded data, page objects)

---

## Common Issues and Resolutions

### Issue: BMad artifacts not found

**Problem:** Story, tech-spec, or PRD files not found when variables are set.

**Resolution:**

- **automate does NOT require BMad artifacts** - they are OPTIONAL enhancements
- If files not found, switch to Standalone Mode automatically
- Analyze source code directly without BMad context
- Continue workflow without halting

### Issue: Framework configuration not found

**Problem:** No playwright.config.ts or cypress.config.ts found.

**Resolution:**

- **HALT workflow** - framework is required
- Message: "Framework scaffolding required. Run `bmad tea *framework` first."
- User must run framework workflow before automate

### Issue: No automation targets identified

**Problem:** Neither story, target_feature, nor target_files specified, and auto-discover finds nothing.

**Resolution:**

- Check if source_dir variable is correct
- Verify source code exists in project
- Ask user to specify target_feature or target_files explicitly
- Provide examples: `target_feature: "src/auth/"` or `target_files: "src/auth/login.ts,src/auth/session.ts"`

### Issue: Duplicate coverage detected

**Problem:** Same behavior tested at multiple levels (E2E + API + Component).

**Resolution:**

- Review test level selection framework (test-levels-framework.md)
- Use E2E for critical happy path ONLY
- Use API for business logic variations
- Use Component for UI edge cases
- Remove redundant tests that duplicate coverage

### Issue: Tests have hardcoded data

**Problem:** Tests use hardcoded email addresses, passwords, or other data.

**Resolution:**

- Replace all hardcoded data with factory function calls
- Use faker for all random data generation
- Update data-factories to support all required test scenarios
- Example: `createUser({ email: faker.internet.email() })`

### Issue: Tests are flaky

**Problem:** Tests fail intermittently, pass on retry.

**Resolution:**

- Remove all hard waits (`page.waitForTimeout()`)
- Use explicit waits (`page.waitForSelector()`)
- Apply network-first pattern (route interception before navigation)
- Remove conditional flow (`if (await element.isVisible())`)
- Ensure tests are deterministic (no race conditions)
- Run burn-in loop (10 iterations) to detect flakiness

### Issue: Fixtures don't clean up data

**Problem:** Test data persists after test run, causing test pollution.

**Resolution:**

- Ensure all fixtures have cleanup in teardown phase
- Cleanup happens AFTER `await use(data)`
- Call deletion/cleanup functions (deleteUser, deleteProduct, etc.)
- Verify cleanup works by checking database/storage after test run

### Issue: Tests too slow

**Problem:** Tests take longer than 90 seconds (max_test_duration).

**Resolution:**

- Remove unnecessary waits and delays
- Use parallel execution where possible
- Mock external services (don't make real API calls)
- Use API tests instead of E2E for business logic
- Optimize test data creation (use in-memory database, etc.)

---

## Notes for TEA Agent

- **automate is flexible:** Can work with or without BMad artifacts (story, tech-spec, PRD are OPTIONAL)
- **Standalone mode is powerful:** Analyze any codebase and generate tests independently
- **Auto-discover mode:** Scan codebase for features needing tests when no targets specified
- **Framework is the ONLY hard requirement:** HALT if framework config missing, otherwise proceed
- **Avoid duplicate coverage:** E2E for critical paths only, API/Component for variations
- **Priority tagging enables selective execution:** P0 tests run on every commit, P1 on PR, P2 nightly
- **Network-first pattern prevents race conditions:** Route interception BEFORE navigation
- **No page objects:** Keep tests simple, direct, and maintainable
- **Use knowledge base:** Load relevant fragments (test-levels, test-priorities, fixture-architecture, data-factories, healing patterns) for guidance
- **Deterministic tests only:** No hard waits, no conditional flow, no flaky patterns allowed
- **Optional healing:** auto_heal_failures disabled by default (opt-in for automatic test healing)
- **Graceful degradation:** Healing works without Playwright MCP (pattern-based fallback)
- **Unfixable tests handled:** Mark with test.fixme() and detailed comments (not silently broken)
