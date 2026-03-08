---
stepsCompleted: []
lastStep: ""
lastSaved: ""
workflowType: "testarch-atdd"
inputDocuments: []
---

# ATDD Checklist - Epic {epic_num}, Story {story_num}: {story_title}

**Date:** {date}
**Author:** {user_name}
**Primary Test Level:** {primary_level}

---

## Story Summary

{Brief 2-3 sentence summary of the user story}

**As a** {user_role}
**I want** {feature_description}
**So that** {business_value}

---

## Acceptance Criteria

{List all testable acceptance criteria from the story}

1. {Acceptance criterion 1}
2. {Acceptance criterion 2}
3. {Acceptance criterion 3}

---

## Failing Tests Created (RED Phase)

### E2E Tests ({e2e_test_count} tests)

**File:** `{e2e_test_file_path}` ({line_count} lines)

{List each E2E test with its current status and expected failure reason}

- ✅ **Test:** {test_name}
  - **Status:** RED - {failure_reason}
  - **Verifies:** {what_this_test_validates}

### API Tests ({api_test_count} tests)

**File:** `{api_test_file_path}` ({line_count} lines)

{List each API test with its current status and expected failure reason}

- ✅ **Test:** {test_name}
  - **Status:** RED - {failure_reason}
  - **Verifies:** {what_this_test_validates}

### Component Tests ({component_test_count} tests)

**File:** `{component_test_file_path}` ({line_count} lines)

{List each component test with its current status and expected failure reason}

- ✅ **Test:** {test_name}
  - **Status:** RED - {failure_reason}
  - **Verifies:** {what_this_test_validates}

---

## Data Factories Created

{List all data factory files created with their exports}

### {Entity} Factory

**File:** `tests/support/factories/{entity}.factory.ts`

**Exports:**

- `create{Entity}(overrides?)` - Create single entity with optional overrides
- `create{Entity}s(count)` - Create array of entities

**Example Usage:**

```typescript
const user = createUser({ email: "specific@example.com" });
const users = createUsers(5); // Generate 5 random users
```

---

## Fixtures Created

{List all test fixture files created with their fixture names and descriptions}

### {Feature} Fixtures

**File:** `tests/support/fixtures/{feature}.fixture.ts`

**Fixtures:**

- `{fixtureName}` - {description_of_what_fixture_provides}
  - **Setup:** {what_setup_does}
  - **Provides:** {what_test_receives}
  - **Cleanup:** {what_cleanup_does}

**Example Usage:**

```typescript
import { test } from './fixtures/{feature}.fixture';

test('should do something', async ({ {fixtureName} }) => {
  // {fixtureName} is ready to use with auto-cleanup
});
```

---

## Mock Requirements

{Document external services that need mocking and their requirements}

### {Service Name} Mock

**Endpoint:** `{HTTP_METHOD} {endpoint_url}`

**Success Response:**

```json
{
  {success_response_example}
}
```

**Failure Response:**

```json
{
  {failure_response_example}
}
```

**Notes:** {any_special_mock_requirements}

---

## Required data-testid Attributes

{List all data-testid attributes required in UI implementation for test stability}

### {Page or Component Name}

- `{data-testid-name}` - {description_of_element}
- `{data-testid-name}` - {description_of_element}

**Implementation Example:**

```tsx
<button data-testid="login-button">Log In</button>
<input data-testid="email-input" type="email" />
<div data-testid="error-message">{errorText}</div>
```

---

## Implementation Checklist

{Map each failing test to concrete implementation tasks that will make it pass}

### Test: {test_name_1}

**File:** `{test_file_path}`

**Tasks to make this test pass:**

- [ ] {Implementation task 1}
- [ ] {Implementation task 2}
- [ ] {Implementation task 3}
- [ ] Add required data-testid attributes: {list_of_testids}
- [ ] Run test: `{test_execution_command}`
- [ ] ✅ Test passes (green phase)

**Estimated Effort:** {effort_estimate} hours

---

### Test: {test_name_2}

**File:** `{test_file_path}`

**Tasks to make this test pass:**

- [ ] {Implementation task 1}
- [ ] {Implementation task 2}
- [ ] {Implementation task 3}
- [ ] Add required data-testid attributes: {list_of_testids}
- [ ] Run test: `{test_execution_command}`
- [ ] ✅ Test passes (green phase)

**Estimated Effort:** {effort_estimate} hours

---

## Running Tests

```bash
# Run all failing tests for this story
{test_command_all}

# Run specific test file
{test_command_specific_file}

# Run tests in headed mode (see browser)
{test_command_headed}

# Debug specific test
{test_command_debug}

# Run tests with coverage
{test_command_coverage}
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete) ✅

**TEA Agent Responsibilities:**

- ✅ All tests written and failing
- ✅ Fixtures and factories created with auto-cleanup
- ✅ Mock requirements documented
- ✅ data-testid requirements listed
- ✅ Implementation checklist created

**Verification:**

- All tests run and fail as expected
- Failure messages are clear and actionable
- Tests fail due to missing implementation, not test bugs

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Pick one failing test** from implementation checklist (start with highest priority)
2. **Read the test** to understand expected behavior
3. **Implement minimal code** to make that specific test pass
4. **Run the test** to verify it now passes (green)
5. **Check off the task** in implementation checklist
6. **Move to next test** and repeat

**Key Principles:**

- One test at a time (don't try to fix all at once)
- Minimal implementation (don't over-engineer)
- Run tests frequently (immediate feedback)
- Use implementation checklist as roadmap

**Progress Tracking:**

- Check off tasks as you complete them
- Share progress in daily standup

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. **Verify all tests pass** (green phase complete)
2. **Review code for quality** (readability, maintainability, performance)
3. **Extract duplications** (DRY principle)
4. **Optimize performance** (if needed)
5. **Ensure tests still pass** after each refactor
6. **Update documentation** (if API contracts change)

**Key Principles:**

- Tests provide safety net (refactor with confidence)
- Make small refactors (easier to debug if tests fail)
- Run tests after each change
- Don't change test behavior (only implementation)

**Completion:**

- All tests pass
- Code quality meets team standards
- No duplications or code smells
- Ready for code review and story approval

---

## Next Steps

1. **Share this checklist and failing tests** with the dev workflow (manual handoff)
2. **Review this checklist** with team in standup or planning
3. **Run failing tests** to confirm RED phase: `{test_command_all}`
4. **Begin implementation** using implementation checklist as guide
5. **Work one test at a time** (red → green for each)
6. **Share progress** in daily standup
7. **When all tests pass**, refactor code for quality
8. **When refactoring complete**, manually update story status to 'done' in sprint-status.yaml

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **fixture-architecture.md** - Test fixture patterns with setup/teardown and auto-cleanup using Playwright's `test.extend()`
- **data-factories.md** - Factory patterns using `@faker-js/faker` for random test data generation with overrides support
- **component-tdd.md** - Component test strategies using Playwright Component Testing
- **network-first.md** - Route interception patterns (intercept BEFORE navigation to prevent race conditions)
- **test-quality.md** - Test design principles (Given-When-Then, one assertion per test, determinism, isolation)
- **test-levels-framework.md** - Test level selection framework (E2E vs API vs Component vs Unit)

See `tea-index.csv` for complete knowledge fragment mapping.

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `{test_command_all}`

**Results:**

```
{paste_test_run_output_showing_all_tests_failing}
```

**Summary:**

- Total tests: {total_test_count}
- Passing: 0 (expected)
- Failing: {total_test_count} (expected)
- Status: ✅ RED phase verified

**Expected Failure Messages:**
{list_expected_failure_messages_for_each_test}

---

## Notes

{Any additional notes, context, or special considerations for this story}

- {Note 1}
- {Note 2}
- {Note 3}

---

## Contact

**Questions or Issues?**

- Ask in team standup
- Tag @{tea_agent_username} in Slack/Discord
- Refer to `./bmm/docs/tea-README.md` for workflow documentation
- Consult `./bmm/testarch/knowledge` for testing best practices

---

**Generated by BMad TEA Agent** - {date}
