# VeriClaw 爪印 App Store Submission Kit

This file is the operator checklist for the iPhone-side App Store submission.

## Metadata source of truth

- App description:
  [description.txt](fastlane/metadata/en-US/description.txt)
- Subtitle:
  [subtitle.txt](fastlane/metadata/en-US/subtitle.txt)
- Promotional text:
  [promotional_text.txt](fastlane/metadata/en-US/promotional_text.txt)
- Keywords:
  [keywords.txt](fastlane/metadata/en-US/keywords.txt)
- Release notes:
  [release_notes.txt](fastlane/metadata/en-US/release_notes.txt)
- App Review notes template:
  [notes.txt](fastlane/metadata/review_information/notes.txt)

## Screenshot plan

Current iPhone screenshot set:

1. [onboarding.png](screenshots/session-2026-03-07/onboarding.png)
2. [settings.png](screenshots/session-2026-03-07/settings.png)
3. [talk-mode.png](screenshots/session-2026-03-07/talk-mode.png)
4. [canvas-cool.png](screenshots/session-2026-03-07/canvas-cool.png)

Suggested product-page caption direction:

1. Connect to your gateway
2. Review evidence and settings
3. Send role-aware follow-up
4. Capture device context fast

## App Review information to fill locally

Before `fastlane ios metadata`, fill these local env vars in
`.env` under `apps/ios/fastlane/`:

- `IOS_APP_REVIEW_FIRST_NAME`
- `IOS_APP_REVIEW_LAST_NAME`
- `IOS_APP_REVIEW_EMAIL`
- `IOS_APP_REVIEW_PHONE`
- `IOS_APP_REVIEW_NOTES_APPEND`

`IOS_APP_REVIEW_NOTES_APPEND` should include the concrete pairing, test gateway,
demo account, or other reviewer-only instructions for this submission.

Local preflight command:

```bash
pnpm ios:review:local-check
```

Compact submission-side gate on the release Mac:

```bash
pnpm release:apple:submit-check
```

Local metadata preview:

```bash
pnpm ios:review:preview
```

This renders the review-contact metadata into
`apps/ios/build/app-store-metadata-preview` so the operator can read the
App Review text exactly as it will be staged locally.

## Open gap before submission

- This synchronized launch path excludes the Watch companion. Keep any watchOS
  screenshots and watch-specific submission media out of the current App Store
  checklist.
- Re-verify that the current iPhone screenshots still match the latest
  `VeriClaw 爪印` branding and onboarding copy.
- Fill the submission-specific App Review notes locally before metadata upload
  and confirm the rendered preview reads naturally.

## Why this checklist exists

Apple's current App Store Connect help says:

- screenshots are required platform-version metadata
- you can upload a minimum of one and a maximum of ten screenshots
- if the UI is the same across device sizes, provide the highest-resolution
  required screenshots and App Store Connect will scale them down
- watchOS screenshots are uploaded in Media Manager only for watchOS apps, which
  are not part of the current launch scope
- App Review notes should include any settings, test registration, or account
  details needed to review the app
