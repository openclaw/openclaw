# Android Release Agent Policy

Root rules still apply. This file adds the Android release guardrails.

## Google Play Releases

- Agent-driven Google Play uploads must use only `pnpm android:release:upload`.
- If `pnpm android:release:upload` exits non-zero, stop immediately and report the failing step.
- After a failed `pnpm android:release:upload`, do not continue with `pnpm android:release:archive`, `pnpm android:release:metadata`, `fastlane android play_store`, `fastlane android metadata`, direct Gradle release artifacts plus Google Play upload commands, Google Play API mutation commands, or mobile release ref recording.
- Do not promote an Android release to production. Production promotion stays manual in Google Play Console unless the user explicitly asks to promote a specific already-prepared release after the failed state has been reported.
- `pnpm android:release:archive` is for local archive validation only. It is not a fallback release path after screenshot, metadata, signing, validation, or upload-lane failure.
