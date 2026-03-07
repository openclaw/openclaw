---
name: "step-03a-subagent-api"
description: "Subagent: Generate API tests only"
subagent: true
outputFile: "/tmp/tea-automate-api-tests-{{timestamp}}.json"
---

# Subagent 3A: Generate API Tests

## SUBAGENT CONTEXT

This is an **isolated subagent** running in parallel with E2E test generation.

**What you have from parent workflow:**

- Target features/components identified in Step 2
- Knowledge fragments loaded: api-request, data-factories, api-testing-patterns
- Config: test framework, Playwright Utils enabled/disabled, Pact.js Utils enabled/disabled, Pact MCP mode
- Coverage plan: which API endpoints need testing

**Your task:** Generate API tests ONLY (not E2E, not fixtures, not other test types).

**If `use_pactjs_utils` is enabled:** Also generate consumer contract tests and provider verification tests alongside API tests. Use the loaded pactjs-utils fragments (`pactjs-utils-overview`, `pactjs-utils-consumer-helpers`, `pactjs-utils-provider-verifier`, `pactjs-utils-request-filter`) for patterns. If `pact_mcp` is `"mcp"`, use SmartBear MCP tools (Fetch Provider States, Generate Pact Tests) to inform test generation.

---

## MANDATORY EXECUTION RULES

- 📖 Read this entire subagent file before acting
- ✅ Generate API tests ONLY
- ✅ Output structured JSON to temp file
- ✅ Follow knowledge fragment patterns
- ❌ Do NOT generate E2E tests (that's subagent 3B)
- ❌ Do NOT run tests (that's step 4)
- ❌ Do NOT generate fixtures yet (that's step 3C aggregation)

---

## SUBAGENT TASK

### 1. Identify API Endpoints

From the coverage plan (Step 2 output), identify:

- Which API endpoints need test coverage
- Expected request/response formats
- Authentication requirements
- Error scenarios to test

### 2. Generate API Test Files

For each API endpoint, create test file in `tests/api/[feature].spec.ts`:

**Test Structure:**

```typescript
import { test, expect } from "@playwright/test";
// If Playwright Utils enabled:
// import { apiRequest } from '@playwright-utils/api';

test.describe("[Feature] API Tests", () => {
  test("[P0] should handle successful [operation]", async ({ request }) => {
    // Use apiRequest helper if Playwright Utils enabled
    // Otherwise use standard request fixture
    const response = await request.post("/api/endpoint", {
      data: {
        /* test data */
      },
    });

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      /* expected */
    });
  });

  test("[P1] should handle [error scenario]", async ({ request }) => {
    // Test error handling
  });
});
```

**Requirements:**

- ✅ Use `apiRequest()` helper if Playwright Utils enabled (from api-request fragment)
- ✅ Use data factories for test data (from data-factories fragment)
- ✅ Follow API testing patterns (from api-testing-patterns fragment)
- ✅ Include priority tags [P0], [P1], [P2], [P3]
- ✅ Test both happy path and error scenarios
- ✅ Use proper TypeScript types
- ✅ Deterministic assertions (no timing dependencies)

**If Pact.js Utils enabled (from `subagentContext.config.use_pactjs_utils`):**

- ✅ Generate consumer contract tests in `pact/http/consumer/` using `createProviderState({ name, params })` pattern
- ✅ Generate provider verification tests in `pact/http/provider/` using `buildVerifierOptions({ provider, port, includeMainAndDeployed, stateHandlers })` pattern
- ✅ Generate request filter helpers in `pact/http/helpers/` using `createRequestFilter({ tokenGenerator: () => string })`
- ✅ Generate shared state constants in `pact/http/helpers/states.ts`
- ✅ If async/message patterns detected, generate message consumer tests in `pact/message/` using `buildMessageVerifierOptions`

### 3. Track Fixture Needs

Identify fixtures needed for API tests:

- Authentication fixtures (auth tokens, API keys)
- Data factories (user data, product data, etc.)
- API client configurations

**Do NOT create fixtures yet** - just track what's needed for aggregation step.

---

## OUTPUT FORMAT

Write JSON to temp file: `/tmp/tea-automate-api-tests-{{timestamp}}.json`

```json
{
  "success": true,
  "subagent": "api-tests",
  "tests": [
    {
      "file": "tests/api/auth.spec.ts",
      "content": "[full TypeScript test file content]",
      "description": "API tests for authentication endpoints",
      "priority_coverage": {
        "P0": 3,
        "P1": 2,
        "P2": 1,
        "P3": 0
      }
    },
    {
      "file": "tests/api/checkout.spec.ts",
      "content": "[full TypeScript test file content]",
      "description": "API tests for checkout endpoints",
      "priority_coverage": {
        "P0": 2,
        "P1": 3,
        "P2": 1,
        "P3": 0
      }
    }
  ],
  "fixture_needs": ["authToken", "userDataFactory", "productDataFactory"],
  "knowledge_fragments_used": ["api-request", "data-factories", "api-testing-patterns"],
  "test_count": 12,
  "summary": "Generated 12 API test cases covering 3 features"
}
```

**On Error:**

```json
{
  "success": false,
  "subagent": "api-tests",
  "error": "Error message describing what went wrong",
  "partial_output": {
    /* any tests generated before error */
  }
}
```

---

## EXIT CONDITION

Subagent completes when:

- ✅ All API endpoints have test files generated
- ✅ All tests follow knowledge fragment patterns
- ✅ JSON output written to temp file
- ✅ Fixture needs tracked

**Subagent terminates here.** Parent workflow will read output and proceed to aggregation.

---

## 🚨 SUBAGENT SUCCESS METRICS

### ✅ SUCCESS:

- All API tests generated following patterns
- JSON output valid and complete
- No E2E/component/unit tests included (out of scope)

### ❌ FAILURE:

- Generated tests other than API tests
- Did not follow knowledge fragment patterns
- Invalid or missing JSON output
- Ran tests (not subagent responsibility)
