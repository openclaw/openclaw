---
name: "step-03b-subagent-e2e"
description: "Subagent: Generate E2E tests only"
subagent: true
outputFile: "/tmp/tea-automate-e2e-tests-{{timestamp}}.json"
---

# Subagent 3B: Generate E2E Tests

## SUBAGENT CONTEXT

This is an **isolated subagent** running in parallel with API test generation.

**What you have from parent workflow:**

- Target features/user journeys identified in Step 2
- Knowledge fragments loaded: fixture-architecture, network-first, selector-resilience
- Config: test framework, Playwright Utils enabled/disabled
- Coverage plan: which user journeys need E2E testing

**Your task:** Generate E2E tests ONLY (not API, not fixtures, not other test types).

---

## MANDATORY EXECUTION RULES

- 📖 Read this entire subagent file before acting
- ✅ Generate E2E tests ONLY
- ✅ Output structured JSON to temp file
- ✅ Follow knowledge fragment patterns
- ❌ Do NOT generate API tests (that's subagent 3A)
- ❌ Do NOT run tests (that's step 4)
- ❌ Do NOT generate fixtures yet (that's step 3C aggregation)

---

## SUBAGENT TASK

### 1. Identify User Journeys

From the coverage plan (Step 2 output), identify:

- Which user journeys need E2E coverage
- Critical user paths (authentication, checkout, profile, etc.)
- UI interactions required
- Expected visual states

### 2. Browser Interaction (Selector Verification)

**Automation mode:** `config.tea_browser_automation`

If `auto` (fall back to MCP if CLI unavailable; if neither available, generate from best practices):

- Open the target page first, then verify selectors with a snapshot:
  `playwright-cli -s=tea-automate-{{timestamp}} open <target_url>`
  `playwright-cli -s=tea-automate-{{timestamp}} snapshot` → map refs to Playwright locators
  - ref `{role: "button", name: "Submit"}` → `page.getByRole('button', { name: 'Submit' })`
  - ref `{role: "textbox", name: "Email"}` → `page.getByRole('textbox', { name: 'Email' })`
- `playwright-cli -s=tea-automate-{{timestamp}} close` when done

If `cli` (CLI only — do NOT fall back to MCP; generate from best practices if CLI unavailable):

- Open the target page first, then verify selectors with a snapshot:
  `playwright-cli -s=tea-automate-{{timestamp}} open <target_url>`
  `playwright-cli -s=tea-automate-{{timestamp}} snapshot` → map refs to Playwright locators
  - ref `{role: "button", name: "Submit"}` → `page.getByRole('button', { name: 'Submit' })`
  - ref `{role: "textbox", name: "Email"}` → `page.getByRole('textbox', { name: 'Email' })`
- `playwright-cli -s=tea-automate-{{timestamp}} close` when done

> **Session Hygiene:** Always close sessions using `playwright-cli -s=tea-automate-{{timestamp}} close`. Do NOT use `close-all` — it kills every session on the machine and breaks parallel execution.

If `mcp`:

- Use MCP tools for selector verification (current behavior)

If `none`:

- Generate selectors from best practices without browser verification

### 3. Generate E2E Test Files

For each user journey, create test file in `tests/e2e/[feature].spec.ts`:

**Test Structure:**

```typescript
import { test, expect } from "@playwright/test";

test.describe("[Feature] E2E User Journey", () => {
  test("[P0] should complete [user journey]", async ({ page }) => {
    // Navigate to starting point
    await page.goto("/feature");

    // Interact with UI
    await page.getByRole("button", { name: "Submit" }).click();

    // Assert expected state
    await expect(page.getByText("Success")).toBeVisible();
  });

  test("[P1] should handle [edge case]", async ({ page }) => {
    // Test edge case scenario
  });
});
```

**Requirements:**

- ✅ Follow fixture architecture patterns (from fixture-architecture fragment)
- ✅ Use network-first patterns: intercept before navigate (from network-first fragment)
- ✅ Use resilient selectors: getByRole, getByText, getByLabel (from selector-resilience fragment)
- ✅ Include priority tags [P0], [P1], [P2], [P3]
- ✅ Test complete user journeys (not isolated clicks)
- ✅ Use proper TypeScript types
- ✅ Deterministic waits (no hard sleeps, use expect().toBeVisible())

### 4. Track Fixture Needs

Identify fixtures needed for E2E tests:

- Page object models (if complex)
- Authentication fixtures (logged-in user state)
- Network mocks/intercepts
- Test data fixtures

**Do NOT create fixtures yet** - just track what's needed for aggregation step.

---

## OUTPUT FORMAT

Write JSON to temp file: `/tmp/tea-automate-e2e-tests-{{timestamp}}.json`

```json
{
  "success": true,
  "subagent": "e2e-tests",
  "tests": [
    {
      "file": "tests/e2e/authentication.spec.ts",
      "content": "[full TypeScript test file content]",
      "description": "E2E tests for user authentication journey",
      "priority_coverage": {
        "P0": 2,
        "P1": 3,
        "P2": 2,
        "P3": 0
      }
    },
    {
      "file": "tests/e2e/checkout.spec.ts",
      "content": "[full TypeScript test file content]",
      "description": "E2E tests for checkout journey",
      "priority_coverage": {
        "P0": 3,
        "P1": 2,
        "P2": 1,
        "P3": 0
      }
    }
  ],
  "fixture_needs": ["authenticatedUserFixture", "paymentMockFixture", "checkoutDataFixture"],
  "knowledge_fragments_used": ["fixture-architecture", "network-first", "selector-resilience"],
  "test_count": 15,
  "summary": "Generated 15 E2E test cases covering 5 user journeys"
}
```

**On Error:**

```json
{
  "success": false,
  "subagent": "e2e-tests",
  "error": "Error message describing what went wrong",
  "partial_output": {
    /* any tests generated before error */
  }
}
```

---

## EXIT CONDITION

Subagent completes when:

- ✅ All user journeys have E2E test files generated
- ✅ All tests follow knowledge fragment patterns
- ✅ JSON output written to temp file
- ✅ Fixture needs tracked

**Subagent terminates here.** Parent workflow will read output and proceed to aggregation.

---

## 🚨 SUBAGENT SUCCESS METRICS

### ✅ SUCCESS:

- All E2E tests generated following patterns
- JSON output valid and complete
- No API/component/unit tests included (out of scope)
- Resilient selectors used (getByRole, getByText)
- Network-first patterns applied (intercept before navigate)

### ❌ FAILURE:

- Generated tests other than E2E tests
- Did not follow knowledge fragment patterns
- Invalid or missing JSON output
- Ran tests (not subagent responsibility)
- Used brittle selectors (CSS classes, XPath)
