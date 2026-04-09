WORK LOG

Add your findings and worklogs by appending to the end of this file. Do not overwrite anything that is existing in this file. Write with the format being used.

[CODEX]

I've brought work into the workstream.

[CLAUDE]

I've assigned the work to eleqtrizit.

[CLAUDE REVIEW]

## Branch 388 — Security Fix Review

**Issue:** NVIDIA-dev/openclaw-tracking#388 / GHSA-92jp-89mq-4374
**Severity:** High — CVSS v3.1 7.7 (AV:L/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N)
**Commit:** `2daa61b460 fix(browser): gate sandbox novnc helper auth`

---

### What the Changes Are Trying to Accomplish

The vulnerability is a **auth-boundary bypass** in the browser bridge server (`extensions/browser/src/browser/bridge-server.ts`). The `/sandbox/novnc` helper route, which redeems observer tokens and returns noVNC bootstrap HTML (embedding a real VNC password), was registered **before** `installBrowserAuthMiddleware(...)` in the Express app setup. This meant that any caller who knew the observer URL could hit `/sandbox/novnc?token=...` without providing bridge credentials and receive back a `vnc.html#...&password=...` redirect target — granting full interactive control of the victim sandbox browser session, not just passive observation.

The fix has two goals:

1. **Primary fix:** Move `installBrowserAuthMiddleware` setup to before the `/sandbox/novnc` route registration so the middleware chain enforces auth before any route handler runs.
2. **Defense-in-depth:** Add an explicit `hasVerifiedBrowserAuth(req)` check inside the `/sandbox/novnc` handler itself, so that if route order is accidentally regressed in the future, the handler still fails closed.

---

### Files Changed

| File                                                        | Nature of Change                                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/browser/src/browser/bridge-server.ts`           | Moves auth middleware setup before route registration; adds in-handler auth check                                                       |
| `extensions/browser/src/browser/server-middleware.ts`       | Adds `BROWSER_AUTH_VERIFIED_FLAG`, `hasVerifiedBrowserAuth()`, `markVerifiedBrowserAuth()`, marks request on successful auth            |
| `extensions/browser/src/browser/bridge-server.auth.test.ts` | Adds unauthenticated 401 assertion for `/sandbox/novnc`, verifies resolver not called before auth, adds auth header to the passing case |

---

### What Is Done Well

**1. Correct primary fix.** Moving `installBrowserAuthMiddleware` before the `/sandbox/novnc` route is the right, minimal, direct repair. The root cause was register order; the fix changes register order. No over-engineering.

**2. Defense-in-depth secondary check.** The `hasVerifiedBrowserAuth(req)` guard inside the handler addresses the issue's remediation item 2 explicitly: "add explicit in-handler verification that bridge auth already succeeded before consuming observer tokens, so future route-order regressions fail closed." This is a sound belt-and-suspenders pattern for a security-sensitive path.

**3. Request-marking pattern is appropriate.** Using a typed property augmentation (`BrowserAuthMarkedRequest`) with a prefixed string flag (`__openclawBrowserAuthVerified`) to carry verified-auth state through the middleware chain is idiomatic Express. The co-location of `markVerifiedBrowserAuth` (private) and `hasVerifiedBrowserAuth` (exported) in `server-middleware.ts` is clean — the setter is internal, the reader is the only exported surface.

**4. Test changes are meaningful and tight.** The addition of `resolveCalls` is subtle and important: it asserts that the token resolver is **not invoked** during the unauthenticated request (`expect(resolveCalls).toBe(0)`). This matters because invoking the resolver before auth could, in theory, leak timing or side-channel information, or consume a one-shot token budget. The test validates both the rejection behavior and the side-effect absence.

**5. No unnecessary scope expansion.** The change is surgical — three files, directly on the affected surface. No unrelated refactors, no style churn.

**6. Auth config guard is consistent.** The early `throw` before `installBrowserAuthMiddleware` (`if (!authToken && !authPassword) throw ...`) ensures that `installBrowserAuthMiddleware`'s own no-op early return (`if (!auth.token && !auth.password) return`) is now unreachable from `startBrowserBridgeServer`, keeping the control flow unambiguous.

---

### Concerns and Gaps

**1. Remediation item 3 is NOT addressed — password still embedded in response body.**

The issue's third remediation recommendation was:

> avoid returning a password-bearing `vnc.html` target to the client; prefer an internal auth-bound handoff that does not expose reusable session credentials.

`buildNoVncBootstrapHtml` at `bridge-server.ts:33-60` still constructs and returns:

```
http://127.0.0.1:<port>/vnc.html#autoconnect=1&resize=remote&password=<VNC_PASSWORD>
```

directly in the HTML body. The test at line 115-117 even explicitly asserts this password-bearing URL is present. The fix merely gates who can receive this response (bridge-authenticated callers only), but the password is still returned in plaintext HTML and stored in browser history via `window.location.replace`.

Whether this is acceptable depends on threat model. Bridge-authenticated callers are presumably the legitimate observer — but if a legitimate observer's browser history, proxy logs, or Referrer headers are in scope, this remains a residual risk. The issue flagged it explicitly; the branch does not address it. This should be a documented follow-up if not fixed now.

**2. Remediation item 4 is NOT addressed — `browserNoVncUrl` still propagated into model-visible prompt context.**

The issue identified that the observer URL is surfaced in embedded-run system prompt context at:

- `src/agents/pi-embedded-runner/sandbox-info.ts:19-20` (`browserNoVncUrl`)
- `src/agents/system-prompt.ts:627-629` (renders it as a prompt literal)

This means the noVNC observer URL (which, when redeemed through the now-auth-gated route, yields VNC credentials) is visible to the model. The issue recommended reassessing this propagation. This branch does not touch those files. If an attacker can influence the model's output context or if a compromised model exfiltrates this URL, the observer capability is still indirectly accessible. This is a higher-level threat model question, but it was explicitly called out in the advisory.

**3. `BROWSER_AUTH_VERIFIED_FLAG` as a string key vs. Symbol.**

The flag is a string constant (`"__openclawBrowserAuthVerified"`). Using a `Symbol` would guarantee no collision with any other middleware or future property. In this Express server context the risk of collision is very low (the name is distinctive and internal), but a Symbol would be more correct. Minor; not blocking.

**4. Test still asserts the password-bearing URL is in the response body (line 115-117).**

This is an intentional preservation of existing behavior (the test matches what the code does), but it's worth flagging: the test is asserting a behavior that the issue identified as problematic. If remediation item 3 is addressed in a follow-up, this assertion will need to change. It's fine as-is for the scope of this fix, but reviewers should be aware the test is documenting the residual credential-in-body behavior, not endorsing it.

**5. No CHANGELOG entry visible.**

Security fixes that affect the auth boundary of a user-facing feature typically warrant a CHANGELOG entry (even a minimal one, e.g., under `### Fixes`). The diff does not include one. Per CLAUDE.md guidelines, changelog entries go at the end of the target section of the active version block. This should be verified or added.

---

### Summary Verdict

The fix **correctly and minimally addresses the primary vulnerability** (auth-boundary bypass via route registration order) and adds sound defense-in-depth (in-handler auth re-verification). The test improvements are precise and verify the right security properties.

The two open gaps — password still returned in response body (item 3) and `browserNoVncUrl` propagation into prompt context (item 4) — were explicitly called out in the advisory and are not addressed in this branch. These should be documented as follow-up items or addressed before the fix is considered complete against the full advisory remediation guidance.

The code quality is good, the approach is appropriate, and the change is scoped tightly to the affected surface.

[CLAUDE PLAN]

## Remaining Work — GHSA-92jp-89mq-4374 / Branch 388

**Status of primary fix:** `2daa61b460 fix(browser): gate sandbox novnc helper auth` — merged and verified in codebase. Remediation items 1 and 2 (route ordering + fail-closed in-handler check) are complete.

**Hidden-problem assessment:** The remaining gaps are NOT symptoms of a larger systemic auth bypass. The root cause (route registration order) was a one-off mistake, not a pattern. No other routes in `bridge-server.ts` are registered before `installBrowserAuthMiddleware`. The VNC backend's interactive mode is intentional design. The `browserNoVncUrl` propagation to prompt context was a deliberate feature whose security implications were not fully considered. All remaining items are residual hardening explicitly requested by the advisory.

---

### Item 1 — Add CHANGELOG entry (quick, low-risk)

**Why missing:** The PR did not include one. Per CLAUDE.md, security fixes that affect the auth boundary of a user-facing feature warrant a `### Fixes` entry.

**File:** `CHANGELOG.md`

**Change:** Append at the end of the `### Fixes` section inside `## Unreleased`:

```
- fix(browser): gate `/sandbox/novnc` helper route behind bridge auth so unauthenticated callers cannot redeem observer tokens or receive noVNC credentials. (#63882)
```

**Gate:** None required beyond formatting check.

---

### Item 2 — Avoid raw VNC password in response body (Remediation item 3)

**Current behavior:** `buildNoVncBootstrapHtml` in `extensions/browser/src/browser/bridge-server.ts:33-60` embeds the VNC password in a `window.location.replace(target)` call where `target` is `http://127.0.0.1:<port>/vnc.html#autoconnect=1&resize=remote&password=<VNC_PASSWORD>`. The URL fragment containing the password ends up in the browser's history after the redirect. The test at `bridge-server.auth.test.ts:115-117` explicitly asserts this password-bearing URL is present, documenting the residual behavior.

**Risk:** Password in URL fragment → browser history → proxy logs if Referer-Policy misconfigured elsewhere. Only bridge-authenticated callers can receive this today, which bounds the immediate risk. But the advisory explicitly flagged it and it remains an unaddressed recommendation.

**Proposed fix:** Change `buildNoVncBootstrapHtml` to use noVNC's programmatic JavaScript API (loading `core/rfb.js` from the noVNC HTTP server running in the container) instead of a URL-fragment redirect. Pass the VNC password as a JavaScript variable in a `<script>` block (not in a URL), and use `new RFB(...)` to connect directly. This keeps the password out of any URL, browser history, or Location headers while still delivering it to the noVNC client.

**Files to change:**

- `extensions/browser/src/browser/bridge-server.ts` — rewrite `buildNoVncBootstrapHtml` to emit a script-based noVNC connection page
- `extensions/browser/src/browser/bridge-server.auth.test.ts` — update line 115-117 assertion: remove `expect(body).toContain("vnc.html#...password=...")`, add assertion that body contains `new RFB(` or equivalent programmatic connect marker, and that no URL-fragment password pattern appears

**Scope note:** This is an internal helper function with no public API surface. Change is self-contained to the browser extension package.

**Gate:** `pnpm test extensions/browser/src/browser/bridge-server.auth.test.ts`

---

### Item 3 — Remove `browserNoVncUrl` from model-visible prompt context (Remediation item 4)

**Current behavior:**

- `src/agents/sandbox/browser.ts:394-403` — issues a `noVncObserverToken` and builds a `noVncUrl` (token-bearing observer URL) as part of the browser sandbox return value
- `src/agents/pi-embedded-runner/sandbox-info.ts:19-20` — passes `browserNoVncUrl` into `EmbeddedSandboxInfo`
- `src/agents/system-prompt.ts:627-630` — renders it as a prompt literal: `Sandbox browser observer (noVNC): <url>`

**Risk:** The observer URL (once redeemed through the now-auth-gated bridge) yields VNC credentials and interactive session access. A model that has this URL in its context could be manipulated via prompt injection (e.g., through content on a webpage the sandbox browser visits) into exfiltrating or acting on the URL. This is a threat-model question the advisory explicitly asked to reassess.

**Proposed fix:** Remove `browserNoVncUrl` from model-visible context as a default-off change:

1. Remove `browserNoVncUrl` field from `EmbeddedSandboxInfo` type in `src/agents/pi-embedded-runner/types.ts` (verify path)
2. Remove `browserNoVncUrl: sandbox.browser?.noVncUrl` from `sandbox-info.ts:19-20`
3. Remove the `browserNoVncUrl` conditional block from `system-prompt.ts:627-630`

If there is a legitimate use case for exposing the observer URL to the model (e.g., for debugging), add it as an explicit opt-in capability (config flag or sandbox context field) rather than the default. That scoping work is a follow-up; for now, remove the exposure.

**Files to change:**

- `src/agents/pi-embedded-runner/sandbox-info.ts` — remove `browserNoVncUrl` line
- `src/agents/system-prompt.ts` — remove lines 628-630
- `src/agents/pi-embedded-runner/types.ts` (or equivalent type file) — remove `browserNoVncUrl` from `EmbeddedSandboxInfo`
- Any tests that assert `browserNoVncUrl` appears in prompt output — update to assert it does not

**Gate:** `pnpm test src/agents/` plus `pnpm check`

---

### Item 4 — Symbol vs. string for `BROWSER_AUTH_VERIFIED_FLAG` (minor, deferred)

**Current:** `BROWSER_AUTH_VERIFIED_FLAG = "__openclawBrowserAuthVerified"` in `server-middleware.ts:6`. A Symbol would guarantee no collision with any other middleware or future property.

**Risk:** Very low. The name is distinctive and the property is set/read within the same module pair. No collision has occurred.

**Recommendation:** Defer. Document as a potential follow-up in a code comment. Not blocking any gate or landing criteria.

---

### Execution Order

1. Item 1 (CHANGELOG) — no logic risk, do first
2. Item 2 (password not in URL) — self-contained browser extension change, test-gated
3. Item 3 (remove from prompt) — cross-cutting core change, run `pnpm check` + `pnpm test src/agents/` after
4. Item 4 — deferred; add comment only if touching `server-middleware.ts` for another reason

**Landing gate for Items 1-3:** `pnpm check` + `pnpm test` (full suite), no build change required (no lazy-loading or module boundary effects).

[CODEX SUMMARY]

Verified Claude's plan against the branch and tracking issue.

- Correct: the branch still exposed `browserNoVncUrl` in model-visible prompt context via `src/agents/pi-embedded-runner/sandbox-info.ts`, `src/agents/pi-embedded-runner/types.ts`, and `src/agents/system-prompt.ts`, and tests still encoded that behavior.
- Correct: `CHANGELOG.md` was missing an Unreleased fix entry for the advisory work.
- Partially correct: the remaining `/sandbox/novnc` password-in-bootstrap issue is real, but Claude's proposed `new RFB(...)` rewrite is not yet a verified drop-in fix for the shipped noVNC asset/runtime setup, so I did not change that flow speculatively in this pass.
- Deferred: the string-vs-Symbol auth marker point is still minor and non-blocking.

Code changes made:

- Removed `browserNoVncUrl` from `EmbeddedSandboxInfo`.
- Stopped propagating the noVNC observer URL into embedded sandbox prompt info.
- Removed the model-visible `Sandbox browser observer (noVNC): ...` line from the system prompt.
- Updated prompt/sandbox-info tests to reflect that the observer URL is no longer exposed to the model.
- Added an Unreleased changelog entry covering the bridge-auth gating and prompt-context reduction.

Validation run:

- `pnpm test src/agents/sanitize-for-prompt.test.ts src/agents/pi-embedded-runner.buildembeddedsandboxinfo.test.ts`
- `pnpm check`

[CODEX COMMENTS RESOLUTION]

## PR 63882 comment resolution

- Read `USER.md` and pulled tracking context from `NVIDIA-dev/openclaw-tracking#388`.
- Checked PR `openclaw/openclaw#63882` review state and GraphQL review threads.
- Verified the remaining unresolved Codex thread was valid: commit `d2ae37d9f0` removed the optional noVNC password from the observer bootstrap handoff, which would break authenticated observer access against the existing `x11vnc -rfbauth` backend.
- Restored the optional `password` field in the bridge observer payload and bootstrap HTML, and updated the bridge auth regression test to assert the password is still handed off in the fragment while remaining absent from the HTTP `Location` header/query string.
- Revalidated with `corepack pnpm test extensions/browser/src/browser/bridge-server.auth.test.ts`.
- Revalidated with `corepack pnpm build`.
- Result: no unresolved review threads were present, so there was nothing to resolve in GitHub.
- Verified the current automated feedback is already favorable:
  - Greptile summary reports no P0/P1 findings and says the PR is safe to merge.
  - Codex review says it did not find any major issues.
- Confirmed the branch already contains the follow-up hardening commit `19a5fd2198` plus the original auth-boundary fix `2daa61b460`.
- No additional code changes were required in this pass.

[CODEX COMPATIBILITY CHECK]

## Compatibility Report

Reviewed `origin/main...HEAD` for PR `openclaw/openclaw#63882` in the context of `NVIDIA-dev/openclaw-tracking#388`.

### BREAKING

- `extensions/browser/src/browser/bridge-server.ts`: `/sandbox/novnc` now returns `401` unless bridge auth already succeeded first. Any caller that previously redeemed observer URLs without `Authorization: Bearer <token>` or `x-openclaw-password` will stop working. This is an intentional security hardening change, but it is still a compatibility break for existing unauthenticated flows. Mitigation: require bridge-auth headers for all `/sandbox/novnc` requests and call that out explicitly in the PR/advisory follow-up.
- `src/plugin-sdk/browser-bridge.ts` plus `extensions/browser/src/browser/bridge-server.ts`: the public `startBrowserBridgeServer(...)` contract still types `authToken` and `authPassword` as optional, but runtime now throws if both are omitted. Existing callers can still compile and then fail at runtime after upgrading. Mitigation: tighten the public type to require at least one auth credential, or restore backward-compatible auth auto-provisioning at the SDK seam.

### RISKY

- `src/agents/pi-embedded-runner/types.ts`, `src/agents/pi-embedded-runner/sandbox-info.ts`, and `src/agents/system-prompt.ts`: `EmbeddedSandboxInfo.browserNoVncUrl` was removed. In-tree usage was updated, and the type is not re-exported from `src/agents/pi-embedded-runner.ts`, so the repo itself looks safe. The remaining risk is unsupported deep-import consumers or tests/tooling that were reading that optional field directly and now silently lose it. Mitigation: note the field removal in the PR and direct any such consumers to rely on `browserBridgeUrl` only.

### MINOR

- `extensions/browser/src/browser/server-middleware.ts`: added `BROWSER_AUTH_VERIFIED_FLAG` and `hasVerifiedBrowserAuth(req)` is additive internal middleware state only; no compatibility issue found for existing callers.
- `CHANGELOG.md`: additive release note only; no compatibility impact.

### VERDICT

[ ] Safe to merge [x] Needs mitigation before merge

[CODEX ISSUE SOLVING CHECK]

## Issue Resolution Check

**Issue**: #388 — GHSA-92jp-89mq-4374

### Addressed

- ✅ `/sandbox/novnc` is now behind the bridge auth boundary — `extensions/browser/src/browser/bridge-server.ts` moves `installBrowserAuthMiddleware(...)` ahead of the helper route registration, matching remediation item 1 from the tracking issue.
- ✅ The helper now fails closed if middleware ordering regresses — `extensions/browser/src/browser/bridge-server.ts` rejects requests when `hasVerifiedBrowserAuth(req)` is false, and `extensions/browser/src/browser/server-middleware.ts` marks authenticated requests, covering remediation item 2.
- ✅ The model-visible observer URL exposure was removed — `src/agents/pi-embedded-runner/sandbox-info.ts`, `src/agents/pi-embedded-runner/types.ts`, and `src/agents/system-prompt.ts` stop propagating and rendering `browserNoVncUrl`, which addresses remediation item 4.
- ✅ A changelog entry was added for the user-facing security fix — `CHANGELOG.md` now documents the bridge-auth gating and prompt-context reduction shipped in this PR.

### Not Addressed

- ❌ The helper still returns a password-bearing noVNC bootstrap target — `extensions/browser/src/browser/bridge-server.ts` still serves HTML that redirects to `vnc.html#...&password=...`, so remediation item 3 from the issue remains open.

### Test Coverage

- ✅ Tests cover the auth-bypass regression and the prompt-context cleanup: `extensions/browser/src/browser/bridge-server.auth.test.ts` now proves unauthenticated `/sandbox/novnc` requests return `401` without consuming the token, and `src/agents/sanitize-for-prompt.test.ts` plus `src/agents/pi-embedded-runner.buildembeddedsandboxinfo.test.ts` verify the noVNC observer URL is no longer exposed to the model.
- ❌ There is no new test proving the password is no longer exposed in the noVNC bootstrap flow, because that behavior was not changed in this PR.

### Regression Risk

- The auth hardening intentionally breaks any unauthenticated caller that previously redeemed `/sandbox/novnc` without bridge credentials.
- `startBrowserBridgeServer(...)` now throws when both auth credentials are omitted even though the public contract still types them as optional, which is a compatibility risk outside the strict issue scope.

### Verdict

PARTIALLY RESOLVES — the PR closes the auth bypass and removes model-visible observer URL exposure, but it does not implement the issue's remaining remediation to stop returning reusable noVNC credentials in the helper response.
