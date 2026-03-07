---
name: "step-03c-aggregate"
description: "Aggregate subagent outputs and complete test infrastructure"
outputFile: "{test_artifacts}/automation-summary.md"
nextStepFile: "./step-04-validate-and-summarize.md"
---

# Step 3C: Aggregate Test Generation Results

## STEP GOAL

Read outputs from parallel subagents (API + E2E and/or Backend test generation based on `{detected_stack}`), aggregate results, and create supporting infrastructure (fixtures, helpers).

---

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- ✅ Read subagent outputs from temp files
- ✅ Generate shared fixtures based on fixture needs from both subagents
- ✅ Write all generated test files to disk
- ❌ Do NOT regenerate tests (use subagent outputs)
- ❌ Do NOT run tests yet (that's step 4)

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Record outputs before proceeding
- 📖 Load the next step only when instructed

## CONTEXT BOUNDARIES:

- Available context: config, subagent outputs from temp files
- Focus: aggregation and fixture generation only
- Limits: do not execute future steps
- Dependencies: Step 3A and 3B subagent outputs

---

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise.

### 1. Read Subagent Outputs

**Read API test subagent output (always):**

```javascript
const apiTestsPath = "/tmp/tea-automate-api-tests-{{timestamp}}.json";
const apiTestsOutput = JSON.parse(fs.readFileSync(apiTestsPath, "utf8"));
```

**Read E2E test subagent output (if {detected_stack} is `frontend` or `fullstack`):**

```javascript
let e2eTestsOutput = null;
if (detected_stack === "frontend" || detected_stack === "fullstack") {
  const e2eTestsPath = "/tmp/tea-automate-e2e-tests-{{timestamp}}.json";
  e2eTestsOutput = JSON.parse(fs.readFileSync(e2eTestsPath, "utf8"));
}
```

**Read Backend test subagent output (if {detected_stack} is `backend` or `fullstack`):**

```javascript
let backendTestsOutput = null;
if (detected_stack === "backend" || detected_stack === "fullstack") {
  const backendTestsPath = "/tmp/tea-automate-backend-tests-{{timestamp}}.json";
  backendTestsOutput = JSON.parse(fs.readFileSync(backendTestsPath, "utf8"));
}
```

**Verify all launched subagents succeeded:**

- Check `apiTestsOutput.success === true`
- If E2E was launched: check `e2eTestsOutput.success === true`
- If Backend was launched: check `backendTestsOutput.success === true`
- If any failed, report error and stop (don't proceed)

---

### 2. Write All Test Files to Disk

**Write API test files:**

```javascript
apiTestsOutput.tests.forEach((test) => {
  fs.writeFileSync(test.file, test.content, "utf8");
  console.log(`✅ Created: ${test.file}`);
});
```

**Write E2E test files (if {detected_stack} is `frontend` or `fullstack`):**

```javascript
if (e2eTestsOutput) {
  e2eTestsOutput.tests.forEach((test) => {
    fs.writeFileSync(test.file, test.content, "utf8");
    console.log(`✅ Created: ${test.file}`);
  });
}
```

**Write Backend test files (if {detected_stack} is `backend` or `fullstack`):**

```javascript
if (backendTestsOutput) {
  backendTestsOutput.testsGenerated.forEach((test) => {
    fs.writeFileSync(test.file, test.content, "utf8");
    console.log(`✅ Created: ${test.file}`);
  });
}
```

---

### 3. Aggregate Fixture Needs

**Collect all fixture needs from all launched subagents:**

```javascript
const allFixtureNeeds = [
  ...apiTestsOutput.fixture_needs,
  ...(e2eTestsOutput ? e2eTestsOutput.fixture_needs : []),
  ...(backendTestsOutput ? backendTestsOutput.coverageSummary?.fixtureNeeds || [] : []),
];

// Remove duplicates
const uniqueFixtures = [...new Set(allFixtureNeeds)];
```

**Categorize fixtures:**

- **Authentication fixtures:** authToken, authenticatedUserFixture, etc.
- **Data factories:** userDataFactory, productDataFactory, etc.
- **Network mocks:** paymentMockFixture, apiResponseMocks, etc.
- **Test helpers:** wait/retry/assertion helpers

---

### 4. Generate Fixture Infrastructure

**Create or update fixture files based on needs:**

**A) Authentication Fixtures** (`tests/fixtures/auth.ts`):

```typescript
import { test as base } from "@playwright/test";

export const test = base.extend({
  authenticatedUser: async ({ page }, use) => {
    // Login logic
    await page.goto("/login");
    await page.fill('[name="email"]', "test@example.com");
    await page.fill('[name="password"]', "password");
    await page.click('button[type="submit"]');
    await page.waitForURL("/dashboard");

    await use(page);
  },

  authToken: async ({ request }, use) => {
    // Get auth token for API tests
    const response = await request.post("/api/auth/login", {
      data: { email: "test@example.com", password: "password" },
    });
    const { token } = await response.json();

    await use(token);
  },
});
```

**B) Data Factories** (`tests/fixtures/data-factories.ts`):

```typescript
import { faker } from "@faker-js/faker";

export const createUserData = (overrides = {}) => ({
  name: faker.person.fullName(),
  email: faker.internet.email(),
  ...overrides,
});

export const createProductData = (overrides = {}) => ({
  name: faker.commerce.productName(),
  price: faker.number.int({ min: 10, max: 1000 }),
  ...overrides,
});
```

**C) Network Mocks** (`tests/fixtures/network-mocks.ts`):

```typescript
import { Page } from "@playwright/test";

export const mockPaymentSuccess = async (page: Page) => {
  await page.route("/api/payment/**", (route) => {
    route.fulfill({
      status: 200,
      body: JSON.stringify({ success: true, transactionId: "12345" }),
    });
  });
};
```

**D) Helper Utilities** (`tests/fixtures/helpers.ts`):

```typescript
import { expect, Page } from "@playwright/test";

export const waitForApiResponse = async (page: Page, urlPattern: string) => {
  return page.waitForResponse((response) => response.url().includes(urlPattern) && response.ok());
};
```

---

### 5. Calculate Summary Statistics

**Aggregate test counts (based on `{detected_stack}`):**

```javascript
const e2eCount = e2eTestsOutput ? e2eTestsOutput.test_count : 0;
const backendCount = backendTestsOutput ? (backendTestsOutput.coverageSummary?.totalTests ?? 0) : 0;

const resolvedMode = subagentContext?.execution?.resolvedMode;
const subagentExecutionLabel =
  resolvedMode === "sequential"
    ? "SEQUENTIAL (API then dependent workers)"
    : resolvedMode === "agent-team"
      ? "AGENT-TEAM (parallel worker squad)"
      : resolvedMode === "subagent"
        ? "SUBAGENT (parallel subagents)"
        : `PARALLEL (based on ${detected_stack})`;
const performanceGainLabel =
  resolvedMode === "sequential"
    ? "baseline (no parallel speedup)"
    : resolvedMode === "agent-team" || resolvedMode === "subagent"
      ? "~40-70% faster than sequential"
      : "mode-dependent";

const summary = {
  detected_stack: "{detected_stack}",
  total_tests: apiTestsOutput.test_count + e2eCount + backendCount,
  api_tests: apiTestsOutput.test_count,
  e2e_tests: e2eCount,
  backend_tests: backendCount,
  fixtures_created: uniqueFixtures.length,
  api_test_files: apiTestsOutput.tests.length,
  e2e_test_files: e2eTestsOutput ? e2eTestsOutput.tests.length : 0,
  backend_test_files: backendTestsOutput ? backendTestsOutput.testsGenerated.length : 0,
  priority_coverage: {
    P0:
      (apiTestsOutput.priority_coverage?.P0 ?? 0) +
      (e2eTestsOutput?.priority_coverage?.P0 ?? 0) +
      (backendTestsOutput?.testsGenerated?.reduce(
        (sum, t) => sum + (t.priority_coverage?.P0 ?? 0),
        0,
      ) ?? 0),
    P1:
      (apiTestsOutput.priority_coverage?.P1 ?? 0) +
      (e2eTestsOutput?.priority_coverage?.P1 ?? 0) +
      (backendTestsOutput?.testsGenerated?.reduce(
        (sum, t) => sum + (t.priority_coverage?.P1 ?? 0),
        0,
      ) ?? 0),
    P2:
      (apiTestsOutput.priority_coverage?.P2 ?? 0) +
      (e2eTestsOutput?.priority_coverage?.P2 ?? 0) +
      (backendTestsOutput?.testsGenerated?.reduce(
        (sum, t) => sum + (t.priority_coverage?.P2 ?? 0),
        0,
      ) ?? 0),
    P3:
      (apiTestsOutput.priority_coverage?.P3 ?? 0) +
      (e2eTestsOutput?.priority_coverage?.P3 ?? 0) +
      (backendTestsOutput?.testsGenerated?.reduce(
        (sum, t) => sum + (t.priority_coverage?.P3 ?? 0),
        0,
      ) ?? 0),
  },
  knowledge_fragments_used: [
    ...apiTestsOutput.knowledge_fragments_used,
    ...(e2eTestsOutput ? e2eTestsOutput.knowledge_fragments_used : []),
    ...(backendTestsOutput ? backendTestsOutput.knowledge_fragments_used || [] : []),
  ],
  subagent_execution: subagentExecutionLabel,
  performance_gain: performanceGainLabel,
};
```

**Store summary for Step 4:**
Save summary to temp file for validation step:

```javascript
fs.writeFileSync(
  "/tmp/tea-automate-summary-{{timestamp}}.json",
  JSON.stringify(summary, null, 2),
  "utf8",
);
```

---

### 6. Optional Cleanup

**Clean up subagent temp files** (optional - can keep for debugging):

```javascript
fs.unlinkSync(apiTestsPath);
if (e2eTestsOutput) fs.unlinkSync("/tmp/tea-automate-e2e-tests-{{timestamp}}.json");
if (backendTestsOutput) fs.unlinkSync("/tmp/tea-automate-backend-tests-{{timestamp}}.json");
console.log("✅ Subagent temp files cleaned up");
```

---

## OUTPUT SUMMARY

Display to user:

```
✅ Test Generation Complete ({subagent_execution})

📊 Summary:
- Stack Type: {detected_stack}
- Total Tests: {total_tests}
  - API Tests: {api_tests} ({api_test_files} files)
  - E2E Tests: {e2e_tests} ({e2e_test_files} files)         [if frontend/fullstack]
  - Backend Tests: {backend_tests} ({backend_test_files} files)  [if backend/fullstack]
- Fixtures Created: {fixtures_created}
- Priority Coverage:
  - P0 (Critical): {P0} tests
  - P1 (High): {P1} tests
  - P2 (Medium): {P2} tests
  - P3 (Low): {P3} tests

🚀 Performance: {performance_gain}

📂 Generated Files:
- tests/api/[feature].spec.ts                                [always]
- tests/e2e/[feature].spec.ts                                [if frontend/fullstack]
- tests/unit/[feature].test.*                                 [if backend/fullstack]
- tests/integration/[feature].test.*                          [if backend/fullstack]
- tests/fixtures/ or tests/support/                           [shared infrastructure]

✅ Ready for validation (Step 4)
```

---

## EXIT CONDITION

Proceed to Step 4 when:

- ✅ All test files written to disk (API + E2E and/or Backend, based on `{detected_stack}`)
- ✅ All fixtures and helpers created
- ✅ Summary statistics calculated and saved
- ✅ Output displayed to user

---

### 7. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-03c-aggregate"]
  lastStep: "step-03c-aggregate"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-03c-aggregate'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-03c-aggregate'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section.

Load next step: `{nextStepFile}`

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- All launched subagents succeeded (based on `{detected_stack}`)
- All test files written to disk
- Fixtures generated based on subagent needs
- Summary complete and accurate

### ❌ SYSTEM FAILURE:

- One or more subagents failed
- Test files not written to disk
- Fixtures missing or incomplete
- Summary missing or inaccurate

**Master Rule:** Do NOT proceed to Step 4 if aggregation incomplete.
