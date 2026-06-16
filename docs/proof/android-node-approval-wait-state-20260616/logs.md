# Android Node Approval Wait-State Proof Log

This is the shareable text proof log for PR #93792. Raw setup-code material,
gateway tokens, private API responses, screenshots, and UIAutomator dumps were
preserved outside the repo and were not copied here.

## Real Environment

- Branch: `codex/android-node-approval-state`
- Device: Android Studio-launched AVD `OpenClaw_FinalProof_API_36`
- Serial: `emulator-5554`
- Android: `16`
- Gateway: isolated local OpenClaw gateway on a non-default loopback port

## Steps Run

```text
Verified Android Studio AVD with adb devices -l, getprop ro.boot.qemu.avd_name,
getprop sys.boot_completed, and getprop ro.build.version.release.

Built APK with Android Studio JBR/SDK:
node scripts/run-android-gradle.mjs :app:assemblePlayDebug

Installed APK:
adb install -r

Started isolated gateway from the fix branch with proof-owned OPENCLAW_HOME,
OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, and a private gateway token.

Generated setup code with the same isolated gateway env/state.

Cleared only ai.openclaw.app data, launched .MainActivity, drove first-run ->
Advanced -> setup-code entry -> Pair with Gateway via ADB taps/text.

Captured screenshots and UIAutomator dumps as private/external proof artifacts,
then copied only sanitized node.list output and projection assertions into this
repo log.
```

## After-Fix Live Output

External image proof from the live AVD run:

```text
https://github.com/Solvely-Colin/openclaw-pr-93792-proof/blob/main/images/before-permission-setup.png
https://github.com/Solvely-Colin/openclaw-pr-93792-proof/blob/main/images/after-node-approval-pending.png
```

Android UI text after setup-code pairing:

```text
Gateway Recovery
Node Approval Pending
Gateway pairing worked.
Approve this phone's node capabilities from an operator UI.
Last gateway
Home Gateway
[loopback]:29292
Node approval
Retry connection
Edit connection
Copy diagnostic
```

Gateway read projection assertion:

```text
node_count=1
node paired=True
node connected=True
node approvalState=pending-approval
sensitive_pending_detail_leaks=none
```

Sanitized `node.list` excerpt:

```json
{
  "nodes": [
    {
      "approvalState": "pending-approval",
      "caps": [],
      "clientId": "[id]",
      "clientMode": "node",
      "commands": [],
      "connected": true,
      "deviceFamily": "Android",
      "displayName": "sdk_gphone64_arm64",
      "modelIdentifier": "Google sdk_gphone64_arm64",
      "nodeId": "[id]",
      "paired": true,
      "platform": "android",
      "version": "2026.6.2-dev"
    }
  ]
}
```

## CI Failure This Bundle Fixes

The first PR body failed the `Real behavior proof` gate because it did not use
the exact required field shape with after-fix real setup evidence:

```text
External PRs must include a Real behavior proof section with after-fix evidence
from a real setup. Add after-fix evidence from a real OpenClaw setup in the PR
body. Screenshots, recordings, terminal screenshots, console output, redacted
runtime logs, linked artifacts, or copied live output count.
```

## Limitations

The proof covers the corrected pending-approval wait state after setup-code
pairing. It does not exercise the later admin/operator approval transition.
