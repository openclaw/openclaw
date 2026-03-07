---
name: "step-04b-subagent-e2e-failing"
description: "Subagent: Generate FAILING E2E tests (TDD red phase)"
subagent: true
outputFile: "/tmp/tea-atdd-e2e-tests-{{timestamp}}.json"
---

# Subagent 4B: Generate Failing E2E Tests (TDD Red Phase)

## SUBAGENT CONTEXT

This is an **isolated subagent** running in parallel with API failing test generation.

**What you have from parent workflow:**

- Story acceptance criteria from Step 1
- Test strategy and user journey scenarios from Step 3
- Knowledge fragments loaded: fixture-architecture, network-first, selector-resilience
- Config: test framework, Playwright Utils enabled/disabled

**Your task:** Generate E2E tests that will FAIL because the feature UI is not implemented yet (TDD RED PHASE).

---

## MANDATORY EXECUTION RULES

- 📖 Read this entire subagent file before acting
- ✅ Generate FAILING E2E tests ONLY
- ✅ Tests MUST fail when run (UI not implemented yet)
- ✅ Output structured JSON to temp file
- ✅ Follow knowledge fragment patterns
- ❌ Do NOT generate API tests (that's subagent 4A)
- ❌ Do NOT generate passing tests (this is TDD red phase)
- ❌ Do NOT run tests (that's step 5)

---

## SUBAGENT TASK

### 1. Identify User Journeys from Acceptance Criteria

From the story acceptance criteria (Step 1 output), identify:

- Which UI flows will be created for this story
- User interactions required
- Expected visual states
- Success/error messages expected

**Example Acceptance Criteria:**

```
Story: User Registration
- As a user, I can navigate to /register page
- I can fill in email and password fields
- I can click "Register" button
- System shows success message and redirects to dashboard
- System shows error if email already exists
```

### 2. Browser Interaction (Selector Verification)

**Automation mode:** `config.tea_browser_automation`

If `auto` (fall back to MCP if CLI unavailable; if neither available, generate from best practices):

- Open the target page first, then verify selectors with a snapshot:
  `playwright-cli -s=tea-atdd-{{timestamp}} open <target_url>`
  `playwright-cli -s=tea-atdd-{{timestamp}} snapshot` → map refs to Playwright locators
  - ref `{role: "button", name: "Submit"}` → `page.getByRole('button', { name: 'Submit' })`
  - ref `{role: "textbox", name: "Email"}` → `page.getByRole('textbox', { name: 'Email' })`
- `playwright-cli -s=tea-atdd-{{timestamp}} close` when done

If `cli` (CLI only — do NOT fall back to MCP; generate from best practices if CLI unavailable):

- Open the target page first, then verify selectors with a snapshot:
  `playwright-cli -s=tea-atdd-{{timestamp}} open <target_url>`
  `playwright-cli -s=tea-atdd-{{timestamp}} snapshot` → map refs to Playwright locators
  - ref `{role: "button", name: "Submit"}` → `page.getByRole('button', { name: 'Submit' })`
  - ref `{role: "textbox", name: "Email"}` → `page.getByRole('textbox', { name: 'Email' })`
- `playwright-cli -s=tea-atdd-{{timestamp}} close` when done

> **Session Hygiene:** Always close sessions using `playwright-cli -s=tea-atdd-{{timestamp}} close`. Do NOT use `close-all` — it kills every session on the machine and breaks parallel execution.

If `mcp`:

- Use MCP tools for selector verification (current behavior)

If `none`:

- Generate selectors from best practices without browser verification

### 3. Generate FAILING E2E Test Files

For each user journey, create test file in `tests/e2e/[feature].spec.ts`:

**Test Structure (ATDD - Red Phase):**

```typescript
import { test, expect } from "@playwright/test";

test.describe("[Story Name] E2E User Journey (ATDD)", () => {
  test.skip("[P0] should complete user registration successfully", async ({ page }) => {
    // THIS TEST WILL FAIL - UI not implemented yet
    await page.goto("/register");

    // Expect registration form but will get 404 or missing elements
    await page.fill('[name="email"]', "newuser@example.com");
    await page.fill('[name="password"]', "SecurePass123!");
    await page.click('button:has-text("Register")');

    // Expect success message and redirect
    await expect(page.getByText("Registration successful!")).toBeVisible();
    await page.waitForURL("/dashboard");
  });

  test.skip("[P1] should show error if email exists", async ({ page }) => {
    // THIS TEST WILL FAIL - UI not implemented yet
    await page.goto("/register");

    await page.fill('[name="email"]', "existing@example.com");
    await page.fill('[name="password"]', "SecurePass123!");
    await page.click('button:has-text("Register")');

    // Expect error message
    await expect(page.getByText("Email already exists")).toBeVisible();
  });
});
```

**CRITICAL ATDD Requirements:**

- ✅ Use `test.skip()` to mark tests as intentionally failing (red phase)
- ✅ Write assertions for EXPECTED UI behavior (even though not implemented)
- ✅ Use resilient selectors: getByRole, getByText, getByLabel (from selector-resilience)
- ✅ Follow network-first patterns if API calls involved (from network-first)
- ✅ Test complete user journeys from acceptance criteria
- ✅ Include priority tags [P0], [P1], [P2], [P3]
- ✅ Use proper TypeScript types
- ✅ Deterministic waits (no hard sleeps)

**Why test.skip():**

- Tests are written correctly for EXPECTED UI behavior
- But we know they'll fail because UI isn't implemented
- `test.skip()` documents this is intentional (TDD red phase)
- Once UI is implemented, remove `test.skip()` to verify green phase

### 4. Track Fixture Needs

Identify fixtures needed for E2E tests:

- Authentication fixtures (if journey requires logged-in state)
- Network mocks (if API calls involved)
- Test data fixtures

**Do NOT create fixtures yet** - just track what's needed for aggregation step.

---

## OUTPUT FORMAT

Write JSON to temp file: `/tmp/tea-atdd-e2e-tests-{{timestamp}}.json`

```json
{
  "success": true,
  "subagent": "atdd-e2e-tests",
  "tests": [
    {
      "file": "tests/e2e/user-registration.spec.ts",
      "content": "[full TypeScript test file content with test.skip()]",
      "description": "ATDD E2E tests for user registration journey (RED PHASE)",
      "expected_to_fail": true,
      "acceptance_criteria_covered": [
        "User can navigate to /register",
        "User can fill registration form",
        "System shows success message on registration",
        "System shows error if email exists"
      ],
      "priority_coverage": {
        "P0": 1,
        "P1": 1,
        "P2": 0,
        "P3": 0
      }
    }
  ],
  "fixture_needs": ["registrationPageMock"],
  "knowledge_fragments_used": ["fixture-architecture", "network-first", "selector-resilience"],
  "test_count": 2,
  "tdd_phase": "RED",
  "summary": "Generated 2 FAILING E2E tests for user registration story"
}
```

**On Error:**

```json
{
  "success": false,
  "subagent": "atdd-e2e-tests",
  "error": "Error message describing what went wrong",
  "partial_output": {
    /* any tests generated before error */
  }
}
```

---

## EXIT CONDITION

Subagent completes when:

- ✅ All user journeys from acceptance criteria have test files
- ✅ All tests use `test.skip()` (documented failing tests)
- ✅ All tests assert EXPECTED UI behavior (not placeholder assertions)
- ✅ Resilient selectors used (getByRole, getByText)
- ✅ JSON output written to temp file
- ✅ Fixture needs tracked

**Subagent terminates here.** Parent workflow will read output and proceed to aggregation.

---

## 🚨 SUBAGENT SUCCESS METRICS

### ✅ SUCCESS:

- All E2E tests generated with test.skip()
- Tests assert expected UI behavior (not placeholders)
- Resilient selectors used (getByRole, getByText)
- JSON output valid and complete
- No API/component/unit tests included (out of scope)
- Tests follow knowledge fragment patterns

### ❌ FAILURE:

- Generated passing tests (wrong - this is RED phase)
- Tests without test.skip() (will break CI)
- Placeholder assertions (expect(true).toBe(true))
- Brittle selectors used (CSS classes, XPath)
- Did not follow knowledge fragment patterns
- Invalid or missing JSON output
