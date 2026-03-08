---
name: "step-04a-subagent-api-failing"
description: "Subagent: Generate FAILING API tests (TDD red phase)"
subagent: true
outputFile: "/tmp/tea-atdd-api-tests-{{timestamp}}.json"
---

# Subagent 4A: Generate Failing API Tests (TDD Red Phase)

## SUBAGENT CONTEXT

This is an **isolated subagent** running in parallel with E2E failing test generation.

**What you have from parent workflow:**

- Story acceptance criteria from Step 1
- Test strategy and scenarios from Step 3
- Knowledge fragments loaded: api-request, data-factories, api-testing-patterns
- Config: test framework, Playwright Utils enabled/disabled

**Your task:** Generate API tests that will FAIL because the feature is not implemented yet (TDD RED PHASE).

---

## MANDATORY EXECUTION RULES

- 📖 Read this entire subagent file before acting
- ✅ Generate FAILING API tests ONLY
- ✅ Tests MUST fail when run (feature not implemented yet)
- ✅ Output structured JSON to temp file
- ✅ Follow knowledge fragment patterns
- ❌ Do NOT generate E2E tests (that's subagent 4B)
- ❌ Do NOT generate passing tests (this is TDD red phase)
- ❌ Do NOT run tests (that's step 5)

---

## SUBAGENT TASK

### 1. Identify API Endpoints from Acceptance Criteria

From the story acceptance criteria (Step 1 output), identify:

- Which API endpoints will be created for this story
- Expected request/response contracts
- Authentication requirements
- Expected status codes and error scenarios

**Example Acceptance Criteria:**

```
Story: User Registration
- As a user, I can POST to /api/users/register with email and password
- System returns 201 Created with user object
- System returns 400 Bad Request if email already exists
- System returns 422 Unprocessable Entity if validation fails
```

### 2. Generate FAILING API Test Files

For each API endpoint, create test file in `tests/api/[feature].spec.ts`:

**Test Structure (ATDD - Red Phase):**

```typescript
import { test, expect } from "@playwright/test";
// If Playwright Utils enabled:
// import { apiRequest } from '@playwright-utils/api';

test.describe("[Story Name] API Tests (ATDD)", () => {
  test.skip("[P0] should register new user successfully", async ({ request }) => {
    // THIS TEST WILL FAIL - Endpoint not implemented yet
    const response = await request.post("/api/users/register", {
      data: {
        email: "newuser@example.com",
        password: "SecurePass123!",
      },
    });

    // Expect 201 but will get 404 (endpoint doesn't exist)
    expect(response.status()).toBe(201);

    const user = await response.json();
    expect(user).toMatchObject({
      id: expect.any(Number),
      email: "newuser@example.com",
    });
  });

  test.skip("[P1] should return 400 if email exists", async ({ request }) => {
    // THIS TEST WILL FAIL - Endpoint not implemented yet
    const response = await request.post("/api/users/register", {
      data: {
        email: "existing@example.com",
        password: "SecurePass123!",
      },
    });

    expect(response.status()).toBe(400);
    const error = await response.json();
    expect(error.message).toContain("Email already exists");
  });
});
```

**CRITICAL ATDD Requirements:**

- ✅ Use `test.skip()` to mark tests as intentionally failing (red phase)
- ✅ Write assertions for EXPECTED behavior (even though not implemented)
- ✅ Use realistic test data (not placeholder data)
- ✅ Test both happy path and error scenarios from acceptance criteria
- ✅ Use `apiRequest()` helper if Playwright Utils enabled
- ✅ Use data factories for test data (from data-factories fragment)
- ✅ Include priority tags [P0], [P1], [P2], [P3]

**Why test.skip():**

- Tests are written correctly for EXPECTED behavior
- But we know they'll fail because feature isn't implemented
- `test.skip()` documents this is intentional (TDD red phase)
- Once feature is implemented, remove `test.skip()` to verify green phase

### 3. Track Fixture Needs

Identify fixtures needed for API tests:

- Authentication fixtures (if endpoints require auth)
- Data factories (user data, etc.)
- API client configurations

**Do NOT create fixtures yet** - just track what's needed for aggregation step.

---

## OUTPUT FORMAT

Write JSON to temp file: `/tmp/tea-atdd-api-tests-{{timestamp}}.json`

```json
{
  "success": true,
  "subagent": "atdd-api-tests",
  "tests": [
    {
      "file": "tests/api/user-registration.spec.ts",
      "content": "[full TypeScript test file content with test.skip()]",
      "description": "ATDD API tests for user registration (RED PHASE)",
      "expected_to_fail": true,
      "acceptance_criteria_covered": [
        "User can register with email/password",
        "System returns 201 on success",
        "System returns 400 if email exists"
      ],
      "priority_coverage": {
        "P0": 1,
        "P1": 2,
        "P2": 0,
        "P3": 0
      }
    }
  ],
  "fixture_needs": ["userDataFactory"],
  "knowledge_fragments_used": ["api-request", "data-factories", "api-testing-patterns"],
  "test_count": 3,
  "tdd_phase": "RED",
  "summary": "Generated 3 FAILING API tests for user registration story"
}
```

**On Error:**

```json
{
  "success": false,
  "subagent": "atdd-api-tests",
  "error": "Error message describing what went wrong",
  "partial_output": {
    /* any tests generated before error */
  }
}
```

---

## EXIT CONDITION

Subagent completes when:

- ✅ All API endpoints from acceptance criteria have test files
- ✅ All tests use `test.skip()` (documented failing tests)
- ✅ All tests assert EXPECTED behavior (not placeholder assertions)
- ✅ JSON output written to temp file
- ✅ Fixture needs to be tracked

**Subagent terminates here.** Parent workflow will read output and proceed to aggregation.

---

## 🚨 SUBAGENT SUCCESS METRICS

### ✅ SUCCESS:

- All API tests generated with test.skip()
- Tests assert expected behavior (not placeholders)
- JSON output valid and complete
- No E2E/component/unit tests included (out of scope)
- Tests follow knowledge fragment patterns

### ❌ FAILURE:

- Generated passing tests (wrong - this is RED phase)
- Tests without test.skip() (will break CI)
- Placeholder assertions (expect(true).toBe(true))
- Did not follow knowledge fragment patterns
- Invalid or missing JSON output
