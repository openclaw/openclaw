# Siri AI preview examples

These examples extend the native OpenClaw App Intents. They do not add a backend,
credential store, voice provider, or second set of intent declarations.

## Opt-in development build only

The `SIRI_AI_PREVIEW` compilation condition enables `@AppIntent(.tool)` on the
existing Open Session, Ask OpenClaw, Check OpenClaw Status, and iOS Open Session
Voice declarations **only when `DEBUG` is also set**. No shipping configuration
defines this flag. Use a preview-capable 27.3 SDK and Apple Intelligence device.

In a disposable Debug development target, pass `-D SIRI_AI_PREVIEW` to the app
and its OpenClawKit Swift package compilation (for a standalone SwiftPM Debug
build, use `-Xswiftc -DSIRI_AI_PREVIEW`). In Xcode, add this directory's
`Skills.skillsbundle` to that development target's Copy Bundle Resources phase
as a Skills Bundle, not as an opaque copied folder. Keep it out of ordinary
Debug and all Release targets. Do not alter the production project to enable it.
The normal iOS project does not include `SiriPreview` in any sources or resources.
The bundle is intentionally not a shared-package resource: it contains an
iPhone-specific live voice skill and belongs only to the opted-in iOS app.

These are unqualified preview examples. The annotation-active branch and skills
compiler have not been verified with SDK 27.3. A passing ordinary build does not
qualify the preview. Never distribute this target externally or through App Store
review. Follow Apple's current preview distribution restrictions.

## Device qualification still required

1. Build the opt-in target with SDK 27.3, inspect generated tool metadata and
   verify all four existing intents occur once. Verify the skills compile and
   the app contains one skills bundle with three uniquely named skills.
2. Inspect a normal Release archive (even with `SIRI_AI_PREVIEW` accidentally
   supplied): none of these declarations may have tool conformance, and the
   archive must not contain the skills bundle.
3. Install the development build on a supported physical device. Test foreground
   and cold-start discovery, local-device authentication, session disambiguation,
   destination confirmation, Gateway permission/approval refusal, route/profile
   changes, and cancellation. Verify read-only status sends no message.
4. Verify Open Session Voice retains the selected session, account, and route.
   The ordinary Start Live Voice shortcut is preserved for saved workflows, but
   is not exported as a preview tool; do not silently fall back to its current chat.
5. For Ask, verify one accepted run, exact-run reply/continuation, pending and
   unavailable replies without resend. For voice, verify microphone permission
   and actual listening rather than inferring them from the startup response.

Skills are guidance, not authorization or a deterministic workflow. Existing
native hosts remain responsible for account binding, route validity, confirmation,
approvals, and run-correlated results. No transcript is indexed in Spotlight by
this change.

References:
- https://developer.apple.com/documentation/appintents/bringing-custom-actions-and-content-to-siri
- https://developer.apple.com/documentation/appintents/orchestrating-complex-actions-with-app-skills
- https://developer.apple.com/documentation/appintents/siri-ai-developer-preview
