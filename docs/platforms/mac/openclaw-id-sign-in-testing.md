---
summary: "Verify OpenClaw ID sign-in returns to the Mac app, including the native WebKit boundary"
read_when:
  - Testing OpenClaw ID sign-in in the Mac app
  - Running the sign-in regression in a disposable Tart VM or GitHub Actions runner
title: "Mac OpenClaw ID sign-in testing"
---

# Mac OpenClaw ID sign-in testing

The acceptance condition is **the original Mac Control UI shows the signed-in
account after authentication**. Opening an issuer page, signing in in Safari or
Chrome, or passing browser-only tests is not sufficient.

The Mac host presents a separate, unprivileged login window and returns the
matching callback to the requesting dashboard document. The Gateway still starts
PKCE and redeems the code; the Control UI still stores the resulting account.
This is separate from native onboarding's sign-in to discover and join claws.
Ordinary browser popup behavior and Gateway authorization rules are unchanged.

The app and an external browser remain separate clients. This does not import
browser cookies or tokens, or automatically sign every client into an account.
An existing Safari/Chrome login may therefore still require authentication in
the app's login window. Once completed there, the app must show the account.

## 1. Prepare an isolated Mac

Use a disposable Tart guest or credentialless macOS Actions worker, with
macOS 26.2+ and Xcode 26.4+ / Swift 6.3. Follow
[Mac development setup](/platforms/mac/dev-setup) for the current Node/pnpm and
build requirements. A temporary HOME or a test filter on an operator desktop is
not isolation. Do not mount the host's Keychain, OpenClaw state, or browser profiles
into the guest. Keep its ordinary system temporary-directory configuration.

Record the checkout SHA, macOS version, Xcode version, and app build before each
run. Do the synthetic tests before signing into the live issuer. Use a disposable
test account and claw for the later live flow.

Inside the guest, from the repository root:

```bash
git status -sb
git rev-parse HEAD
sw_vers
xcodebuild -version
pnpm install --frozen-lockfile
swift build --package-path apps/macos --build-system native --build-tests
swift test --package-path apps/macos --build-system native --skip-build \
  --filter DashboardOpenClawIDSignInTests
```

Do not interpret compilation alone, zero selected tests, skipped tests, or a
process exit without the Swift Testing summary as a pass.

## 2. What the native regression proves

The suite uses the real DashboardWindowController, WK script-message transport,
an ephemeral HTTP issuer fixture, a second WKWebView, and real callback
navigation. It does not replace the native receiver with a JavaScript mock.

It checks:

- successful code delivery to the original document, without navigating that
  document away from the dashboard;
- issuer denial and mismatched callback state;
- cancellation when the person closes the login window or dashboard;
- rejection of subframe requests, documents outside the dashboard mount, and
  callbacks outside that mount;
- no dashboard/device-auth bridges in the issuer page, and closure of the
  login window after settlement.

The fixture supplies the external issuer, not the asserted native response.
It does **not** prove real issuer compatibility, Gateway token redemption, or the
full account-menu click. Section 4 covers those remaining boundaries.

### Red/green comparison

Use separate worktrees inside the disposable guest; do not switch a checkout
that is running the app or tests. For the original report, the inspected base was
`428d2047b766fcf0e8d426c1d967b0c8697b8625`.

From the candidate checkout, create a base worktree and copy **only** the new
regression test into it:

```bash
git worktree add --detach ../openclaw-id-before 428d2047b766fcf0e8d426c1d967b0c8697b8625
cp apps/macos/Tests/OpenClawIPCTests/DashboardOpenClawIDSignInTests.swift \
  ../openclaw-id-before/apps/macos/Tests/OpenClawIPCTests/
```

Install dependencies and build/run the same focused suite from the base
worktree. Its success cases should fail at the absent native sign-in return
channel, not at compilation, fixture startup, or a missing test dependency.
Run the suite from the candidate checkout again and require it to pass.
Record both results; a base setup failure is not red proof. Preserve the base
checkout until the before-app capture is complete.

## 3. GitHub Actions and remaining focused checks

The repository's existing `macos-swift` lane discovers the Swift test file.
Require the lane's build and test results for the **candidate head SHA**, not an
older revision. Inside a normally prepared disposable Actions Mac worker,
after its test build, the existing isolated launcher also supports:

```bash
node scripts/test-macos-native.mts named \
  --package-path apps/macos --build-system native --enable-code-coverage \
  --skip-build --filter DashboardOpenClawIDSignInTests
```

Do not fake Actions environment markers on an ordinary desktop to get through
this launcher's admission checks. Use the Tart command above in a clean guest.
Draft PRs do not automatically run the ordinary CI workflow; follow the
repository's authorized draft/CI dispatch process, or supply the Tart results
before marking the PR ready. Do not treat a skipped draft job as proof.
For a maintainer-authorized canonical draft targeting main, the supported
dispatch is `scripts/pr ci-dispatch <PR_NUMBER>`; verify the resulting run
selected the candidate head. This is not a request to mark an untested PR ready.

The web-side contract checks that a native reply is redeemed and stored in the
app's account owner, while cancellation never falls back to an external browser:

```bash
node scripts/run-vitest.mjs \
  ui/src/lib/openclaw-id/browser-sign-out.test.ts \
  ui/src/components/openclaw-id/account-menu.test.tsx \
  ui/src/lib/open-external-url.test.ts --maxWorkers=1
pnpm tsgo:ui
pnpm native:i18n:verify
scripts/lint-swift.sh macos
scripts/format-swift.sh macos
git diff --check
```

Those web tests cover a separate client contract; they do not substitute for
the native suite or the full-app flow below. Existing URL safety, sign-out and
owner/member tests remain useful independent contracts. Redundant popup-helper
call-shape checks are not sign-in proof.

## 4. Test the actual app against OpenClaw ID

Build **both** the app and the Gateway-served Control UI from the candidate.
Updating only the web assets leaves an older native host without the new bridge.
The normal package command builds both:

```bash
scripts/package-mac-app.sh
open dist/OpenClaw.app
```

Use the normal signing identity. For an otherwise credentialless disposable VM,
the documented development-only alternative is
`ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh`; this is not evidence of
production signing or TCC persistence. See [signing](/platforms/mac/signing).

Use **This Mac**, its test Gateway, and the OpenClaw ID Labs configuration already
known to work in the browser. If using a separate source Gateway, also follow
[the native transport build instructions](/gateway/remote#openclaw-id-from-a-source-checkout).
Verify the app is connected to that Gateway, rather than a host-machine Gateway
or an older installed app. Never paste tokens into the test report.

Exercise these scenarios through the **actual account menu**:

1. **Fresh app sign-in:** click Sign in with OpenClaw ID. A usable login window
   appears; complete the real issuer's authentication. It closes, and reopening
   the original account menu shows the account and Sign out. The original chat
   stays open. Check account-specific actions appropriate to this test claw.
2. **Browser already signed in:** sign into the same loopback Gateway in the
   guest's external browser first. Then start sign-in from the app. Complete any
   app-local authentication; the app must now show its signed-in account too.
   Do not count the external browser's success screen as an app success.
3. **Persistence:** reload the app dashboard and close/reopen it. The same app
   profile and Gateway origin should retain the unexpired account. Quit/relaunch
   the app and verify persistence for its persistent local dashboard store.
4. **Cancel and retry:** close the login window before completing authentication.
   The app stays signed out and reports failure rather than waiting ten minutes.
   A new click opens a fresh usable attempt. Also test issuer denial.
5. **Window lifetime:** start sign-in, then close or reload the dashboard, or
   switch Gateway. The login window must close and must not sign a replacement
   dashboard into the old attempt. Repeated clicks should not leave orphan windows.
6. **Issuer failure:** temporarily disconnect the guest network after opening
   login. Verify a visible failure or issuer error and a working cancel/retry.
   Restore networking before the next scenario.
7. **Browser parity:** repeat sign-in in a normal browser. Its existing popup,
   callback, and account menu still work. Ordinary links in the Mac dashboard
   retain their existing behavior.
8. **Issuer methods:** exercise the real account's password/passkey/social method
   as applicable. A provider refusing embedded WebKit is a **failed live check**,
   not something to work around with a spoofed user agent or weaker policy.
   Report it before treating the patch as ready.

## 5. Evidence to return

Record base/candidate SHAs, toolchain, focused test summaries, and the result of
each full-app scenario. Include a clean before/after pair of the actual Mac
window and account menu, with matching theme/window size and synthetic or
redacted identity. An optional short recording should show the click and return
to the original app. Never capture passwords, one-time codes, callback queries,
tokens, recovery material, or private conversations.

Keep native compile/test results, fixture transport proof, and live account
sign-in results separate. A candidate remains unverified on macOS until those
results are collected; browser-only green tests cannot close that gap.
