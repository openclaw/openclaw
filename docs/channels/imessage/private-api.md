---
summary: "Disable SIP and library validation, inject the imsg helper, and verify the private API bridge"
read_when:
  - Enabling iMessage reactions, edits, effects, polls, or group actions
  - Deciding whether to disable System Integrity Protection
  - Debugging a failed imsg launch
title: "Enabling the imsg private API"
sidebarTitle: "Private API"
---

Private API mode unlocks the native iMessage actions. It needs SIP off, library validation relaxed, and a successful helper injection.

## Enabling the imsg private API

`imsg` ships in two operational modes. For OpenClaw, Private API mode is the recommended setup because it gives the channel the native iMessage actions users expect. Basic mode remains useful for low-risk installs, initial verification, or hosts where SIP cannot be disabled.

- **Basic mode** (default, no SIP changes needed): outbound text and media via `send`, inbound watch/history, chat list. This is what you get out of the box from a fresh `brew install steipete/tap/imsg` plus the standard [macOS permissions](/channels/imessage/setup#requirements-and-permissions-macos).
- **Private API mode**: `imsg` injects a helper dylib into `Messages.app` to call internal `IMCore` functions. This unlocks `react`, `edit`, `unsend`, `reply` (threaded), `sendWithEffect`, `poll` and `poll-vote` (native Messages polls), `renameGroup`, `setGroupIcon`, `addParticipant`, `removeParticipant`, `leaveGroup`, plus typing indicators and read receipts.

The recommended action surface on this page requires Private API mode. The `imsg` README is explicit about the requirement:

> Advanced features such as `read`, `typing`, `launch`, bridge-backed rich send, message mutation, and chat management are opt-in. They require SIP to be disabled and a helper dylib to be injected into `Messages.app`. `imsg launch` refuses to inject when SIP is enabled.

The helper-injection technique uses `imsg`'s own dylib to reach Messages private APIs. There is no third-party server or BlueBubbles runtime in the OpenClaw iMessage path.

<Warning>
**Disabling SIP is a real security tradeoff.** SIP is one of macOS's core protections against running modified system code; turning it off system-wide opens up additional attack surface and side effects. Notably, **disabling SIP on Apple Silicon Macs also disables the ability to install and run iOS apps on your Mac**.

Treat this as a deliberate operational choice, especially on a primary personal Mac. For production-quality OpenClaw iMessage, prefer a dedicated Mac or bot macOS user where you are comfortable enabling the bridge. If your threat model cannot tolerate SIP being off anywhere, the iMessage plugin is limited to basic mode — text and media send/receive only, no reactions / edit / unsend / effects / group ops.
</Warning>

### Setup

1. **Install (or upgrade) `imsg`** on the Mac that runs Messages.app:

   ```bash
   brew install steipete/tap/imsg
   brew update && brew upgrade imsg
   imsg --version
   imsg status --json
   ```

   The `imsg status --json` output reports `bridge_version`, `rpc_methods`, and per-method `selectors` so you can see what the current build supports before you start.

2. **Disable System Integrity Protection, and (on modern macOS) Library Validation.** Injecting a non-Apple helper dylib into the Apple-signed `Messages.app` needs SIP off **and** library validation relaxed. The Recovery-mode SIP step is macOS-version-specific:
   - **macOS 10.13-10.15 (Sierra-Catalina):** disable Library Validation via Terminal, reboot to Recovery Mode, run `csrutil disable`, restart.
   - **macOS 11+ (Big Sur and later), Intel:** Recovery Mode (or Internet Recovery), `csrutil disable`, restart.
   - **macOS 11+, Apple Silicon:** power-button startup sequence to enter Recovery; on recent macOS versions hold the **Left Shift** key when you click Continue, then `csrutil disable`. Virtual-machine setups follow a separate flow, so take a VM snapshot first.

   **On macOS 11 and later, `csrutil disable` alone is usually not enough.** Apple still enforces library validation against `Messages.app` as a platform binary, so an adhoc-signed helper is rejected (`Library Validation failed: ... platform binary, but mapped file is not`) even with SIP off. After disabling SIP, also disable library validation and reboot:

   ```bash
   sudo defaults write /Library/Preferences/com.apple.security.libraryvalidation.plist DisableLibraryValidation -bool true
   ```

   **macOS 26 (Tahoe), verified on 26.5.1:** SIP off **plus** the `DisableLibraryValidation` command above is sufficient to inject the helper across 26.0 through 26.5.x. **No boot-args are required.** The plist is the decisive factor and the most common missing step when injection fails on Tahoe:
   - **With the plist:** `imsg launch` injects and `imsg status` reports `advanced_features: true`.
   - **Without the plist (even with SIP off):** `imsg launch` fails with `Failed to launch: Timeout waiting for Messages.app to initialize`. AMFI rejects the adhoc helper at load, so the bridge never becomes ready and the launch times out. That timeout is the symptom most people hit on Tahoe; the fix is the plist above, not anything more drastic.

   If `imsg launch` injection or specific `selectors` start returning false after a macOS upgrade, this gate is the usual cause. Check your SIP and library-validation state before assuming the SIP step itself failed. If those settings are correct and the bridge still cannot inject, collect `imsg status --json` plus the `imsg launch` output and report it to the `imsg` project instead of weakening additional system-wide security controls.

3. **Inject the helper.** With SIP disabled and Messages.app signed in:

   ```bash
   imsg launch
   ```

   `imsg launch` refuses to inject when SIP is still enabled, so this also doubles as a confirmation that step 2 took.

4. **Verify the bridge from OpenClaw:**

   ```bash
   openclaw channels status --probe
   ```

   The iMessage entry should report `works`, and `imsg status --json | jq '{rpc_methods, selectors}'` should show the capabilities exposed by your macOS build. Poll creation requires `selectors.pollPayloadMessage`; voting requires both `selectors.pollVoteMessage` and the `poll.vote` RPC method. The OpenClaw plugin advertises only actions supported by the cached probe, while an empty cache stays optimistic and probes on first dispatch.

If `openclaw channels status --probe` reports the channel as `works` but specific actions throw "iMessage `<action>` requires the imsg private API bridge" at dispatch time, run `imsg launch` again — the helper can fall out (Messages.app restart, OS update, etc.) and the cached `available: true` status will keep advertising actions until the next probe refreshes.

### When SIP stays enabled

If disabling SIP is not acceptable for your threat model:

- `imsg` falls back to basic mode — text + media + receive only.
- The OpenClaw plugin still advertises text/media send and inbound monitoring; it hides `react`, `edit`, `unsend`, `reply`, `sendWithEffect`, and group ops from the action surface (per the per-method capability gate).
- You can run a separate non-Apple-Silicon Mac (or a dedicated bot Mac) with SIP off for the iMessage workload, while keeping SIP enabled on your primary devices. See [Dedicated bot macOS user (separate iMessage identity)](/channels/imessage/deployment#deployment-patterns).
