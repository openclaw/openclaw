# Android app

## Google Play Releases

- Agent-driven Google Play uploads must use only `pnpm android:release:upload`. The **Android Store Release** GitHub Action calls this owner to plan, generate notes, and upload the selected clean source commit without preparation commits or finalization PRs. Its default `release` operation and Monday 11:00 AM Pacific schedule stage the store listing; `internal` and daily 7:00 AM Pacific runs use `--destination internal`, skip screenshots and listing updates, and publish to `internal` and `wear:internal` before distributing the same signed AABs through Firebase App Distribution (Wear first, then Phone).
- Follow [VERSIONING.md](VERSIONING.md) for public revisions, sequential store codes, immutable source refs, and the legacy cutover. Do not infer a store release identity from a new code's date-like shape or an editable Play release name.
- If `pnpm android:release:upload` exits non-zero, stop immediately and report the failing step; use no other upload path.
- Recovery requires explicit maintainer direction after the failure is reported. If Play accepted the upload but ref recording failed, verify the saved plan and exact uploaded AAB hashes/codes against Play before an authorized record-only repair. Never automatically rerun or re-upload to repair a missing ref.
- Firebase-only recovery: follow [VERSIONING.md](VERSIONING.md#firebase-distribution-and-recovery); never rebuild or repeat the Play upload.
- Do not promote an Android release to production. Production promotion stays manual in Google Play Console unless the user explicitly asks to promote a specific already-prepared release after the failed state has been reported.
- `pnpm android:release:archive` is for local archive validation only. It is not a fallback release path after screenshot, metadata, signing, validation, or upload-lane failure.

## Licenses Screen

- Maintain the Settings-tab Licenses screen when Android app dependencies change.
- Bundled license files live in `apps/android/THIRD_PARTY_LICENSES/openclaw/licenses/`.
- License files: UTF-8 `.txt`, each named after the dependency (`Manrope.txt`).
- Do not add OpenClaw, OpenClaw Foundation, or other first-party/self-owned license entries. The screen is for third-party/open-source dependency acknowledgements.
- When adding, removing, or upgrading Android dependencies, audit whether `apps/android/THIRD_PARTY_LICENSES/openclaw/licenses/` needs updates.
- Keep license detail bodies rendered as verbatim monospace text.
- Keep the Settings `Licenses` section at the bottom of Settings, after `Account`, with a single `Licenses` row and no row subtitle unless product direction changes.
- When changing license loading or presentation, update `apps/android/app/src/test/java/ai/openclaw/app/AndroidLicenseNoticesTest.kt`, then run focused Android validation.
