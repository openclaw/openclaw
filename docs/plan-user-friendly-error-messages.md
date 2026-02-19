# Execution Plan: Improve User-Friendly Error Messages

> **IMPORTANT:** This plan file must NOT be committed to the repository. Keep it for reference and PR description.

---

## Phase 1: Preparation (Steps 0-3)

- [ ] **Step 0: Verify Clean Working Tree**

  ```bash
  git status
  ```

  Ensure working tree is clean (no uncommitted changes) before starting.

- [ ] **Step 1: Run Baseline Tests**

  ```bash
  pnpm test src/auto-reply/reply/agent-runner.runreplyagent.test.ts
  pnpm vitest run --config vitest.e2e.config.ts src/auto-reply/reply.triggers.trigger-handling.includes-error-cause-embedded-agent-throws.e2e.test.ts
  ```

- [ ] **Step 2: Verify Branch**

  ```bash
  git branch
  ```

  Should show: `refactor/improve-error-messages`

- [ ] **Step 3: Verify Imports Available**
      Confirm these functions exist in `src/agents/pi-embedded-helpers.ts`:
  - `isRateLimitErrorMessage()`
  - `isAuthErrorMessage()`
  - `isBillingErrorMessage()`
  - `isTimeoutErrorMessage()`
  - `isOverloadedErrorMessage()`

---

## Phase 2: Code Changes (Steps 4-6)

- [ ] **Step 4: Edit `src/auto-reply/reply/agent-runner-execution.ts`**

  #### 4.1 Add imports (replace lines 7-13):

  ```typescript
  import {
    isAuthErrorMessage,
    isBillingErrorMessage,
    isCompactionFailureError,
    isContextOverflowError,
    isLikelyContextOverflowError,
    isOverloadedErrorMessage,
    isRateLimitErrorMessage,
    isTimeoutErrorMessage,
    isTransientHttpError,
    sanitizeUserFacingText,
  } from "../../agents/pi-embedded-helpers.js";
  ```

  #### 4.2 Add error classification after line 428:

  ```typescript
  // Classify error type for user-friendly messaging
  const isRateLimit = isRateLimitErrorMessage(message);
  const isAuthError = isAuthErrorMessage(message);
  const isBillingError = isBillingErrorMessage(message);
  const isTimeoutError = isTimeoutErrorMessage(message);
  const isOverloaded = isOverloadedErrorMessage(message);
  ```

  #### 4.3 Replace lines 515-524 with user-friendly messages:

  ```typescript
  let fallbackText: string;

  if (isContextOverflow) {
    fallbackText =
      "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model.";
  } else if (isRoleOrderingError) {
    fallbackText =
      "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session.";
  } else if (isRateLimit || isOverloaded) {
    fallbackText = "The AI service is busy. Please wait a moment and try again.";
  } else if (isAuthError) {
    fallbackText =
      "I couldn't connect to the AI service. Please verify your API key is configured correctly.";
  } else if (isBillingError) {
    fallbackText =
      "I've reached my limit with the AI service. Please check your account balance and try again.";
  } else if (isTimeoutError) {
    fallbackText = "The request timed out. Please try again, or start a fresh session with /new.";
  } else {
    fallbackText =
      "Something unexpected happened. Try /new to start a fresh conversation, or try again in a moment.";
  }
  ```

  #### 4.4 Remove lines 516-519 (old safeMessage/trimmedMessage variables - no longer needed)

- [ ] **Step 5: Run Lint**

  ```bash
  pnpm check
  ```

- [ ] **Step 6: Run TypeScript**
  ```bash
  pnpm tsgo
  ```

---

## Phase 3: Test Updates (Steps 7-10)

- [ ] **Step 7: Edit Test File - Existing Test**
      Open: `src/auto-reply/reply.triggers.trigger-handling.includes-error-cause-embedded-agent-throws.e2e.test.ts`

  Update line 69-71:
  - From: `"⚠️ Agent failed before reply: sandbox is not defined.\nLogs: openclaw logs --follow"`
  - To: `"Something unexpected happened. Try /new to start a fresh conversation, or try again in a moment."`

- [ ] **Step 8: Add New Tests**
      Add these 4 new tests to the same file (after the existing test):

  #### 8.1 Rate Limit Error Test

  ```typescript
  it("returns friendly message for rate limit errors", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockRejectedValue(
        new Error("rate_limit_exceeded: API rate limit exceeded"),
      );

      const res = await getReplyFromConfig(BASE_MESSAGE, {}, makeCfg(home));
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("The AI service is busy. Please wait a moment and try again.");
    });
  });
  ```

  #### 8.2 Auth Error Test

  ```typescript
  it("returns friendly message for auth errors", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockRejectedValue(new Error("401 Unauthorized: Invalid API key"));

      const res = await getReplyFromConfig(BASE_MESSAGE, {}, makeCfg(home));
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe(
        "I couldn't connect to the AI service. Please verify your API key is configured correctly.",
      );
    });
  });
  ```

  #### 8.3 Billing Error Test

  ```typescript
  it("returns friendly message for billing errors", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockRejectedValue(
        new Error("402 Payment Required: billing limit exceeded"),
      );

      const res = await getReplyFromConfig(BASE_MESSAGE, {}, makeCfg(home));
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe(
        "I've reached my limit with the AI service. Please check your account balance and try again.",
      );
    });
  });
  ```

  #### 8.4 Timeout Error Test

  ```typescript
  it("returns friendly message for timeout errors", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockRejectedValue(
        new Error("408 Request Timeout: connection timed out"),
      );

      const res = await getReplyFromConfig(BASE_MESSAGE, {}, makeCfg(home));
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe(
        "The request timed out. Please try again, or start a fresh session with /new.",
      );
    });
  });
  ```

- [ ] **Step 9: Edit Unit Test**
      Open: `src/auto-reply/reply/agent-runner.runreplyagent.test.ts`

  Update line ~740-742:
  - Change expected message to: `"Something unexpected happened. Try /new to start a fresh conversation, or try again in a moment."`

- [ ] **Step 10: Run Tests**
  ```bash
  pnpm test src/auto-reply/reply/agent-runner.runreplyagent.test.ts
  pnpm vitest run --config vitest.e2e.config.ts src/auto-reply/reply.triggers.trigger-handling.includes-error-cause-embedded-agent-throws.e2e.test.ts
  ```

---

## Phase 4: Changelog (Step 11)

- [ ] **Step 11: Update CHANGELOG.md**
      Add to `### Fixes` section under `## 2026.2.19`:
  ```markdown
  - Auto-reply: show user-friendly error messages based on error type (rate limit, auth, billing, timeout) instead of exposing technical details.
  ```

---

## Phase 5: Commit & Push (Steps 12-14)

- [ ] **Step 12: Review Changes**

  ```bash
  git diff
  ```

- [ ] **Step 13: Stage and Commit**

  ```bash
  git add src/auto-reply/reply/agent-runner-execution.ts \
         src/auto-reply/reply/agent-runner.runreplyagent.test.ts \
         src/auto-reply/reply.triggers.trigger-handling.includes-error-cause-embedded-agent-throws.e2e.test.ts \
         CHANGELOG.md

  scripts/committer "Auto-reply: improve user-facing error messages" \
    src/auto-reply/reply/agent-runner-execution.ts \
    src/auto-reply/reply/agent-runner.runreplyagent.test.ts \
    src/auto-reply/reply.triggers.trigger-handling.includes-error-cause-embedded-agent-throws.e2e.test.ts \
    CHANGELOG.md
  ```

- [ ] **Step 14: Push**
  ```bash
  git push -u origin refactor/improve-error-messages
  ```

---

## Phase 6: Create PR (Step 15)

- [ ] **Step 15: Create Pull Request**
  - Use GitHub CLI: `gh pr create`
  - Or create via web interface
  - Fill out `.github/pull_request_template.md`

---

## Error Type to Message Mapping

| Error Type             | Detection Function                                    | User-Friendly Message                                                                                     |
| ---------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Context overflow       | `isLikelyContextOverflowError()`                      | "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model." |
| Role ordering conflict | `/incorrect role information\|roles must alternate/i` | "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session."   |
| Rate limit             | `isRateLimitErrorMessage()`                           | "The AI service is busy. Please wait a moment and try again."                                             |
| Overloaded             | `isOverloadedErrorMessage()`                          | "The AI service is busy. Please wait a moment and try again."                                             |
| Auth/API key           | `isAuthErrorMessage()`                                | "I couldn't connect to the AI service. Please verify your API key is configured correctly."               |
| Billing/quota          | `isBillingErrorMessage()`                             | "I've reached my limit with the AI service. Please check your account balance and try again."             |
| Timeout                | `isTimeoutErrorMessage()`                             | "The request timed out. Please try again, or start a fresh session with /new."                            |
| Unknown/other          | fallback                                              | "Something unexpected happened. Try /new to start a fresh conversation, or try again in a moment."        |

---

## Files Modified

| File                                                                                                    | Change Type                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `src/auto-reply/reply/agent-runner-execution.ts`                                                        | Add imports, update catch block |
| `src/auto-reply/reply/agent-runner.runreplyagent.test.ts`                                               | Update expected message         |
| `src/auto-reply/reply.triggers.trigger-handling.includes-error-cause-embedded-agent-throws.e2e.test.ts` | Update 1 test, add 4 new tests  |
| `CHANGELOG.md`                                                                                          | Add Fixes entry                 |

---

## ⚠️ IMPORTANT: DO NOT COMMIT THIS FILE

This plan file is for reference only and must NOT be committed.

When committing, ignore this file (do not stage it):

```bash
# Ensure this file is NOT staged
git reset docs/plan-user-friendly-error-messages.md
```
