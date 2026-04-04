# VeriClaw 爪印 iOS screenshots

Current Apple submission screenshot candidates live in:

- `session-2026-03-07/onboarding.png`
- `session-2026-03-07/settings.png`
- `session-2026-03-07/talk-mode.png`
- `session-2026-03-07/canvas-cool.png`

Current dimensions:

- all four PNGs are `1320 x 2868`

Recommended App Store upload order:

1. `onboarding.png`
2. `settings.png`
3. `talk-mode.png`
4. `canvas-cool.png`

Suggested caption direction for those four frames:

1. `Connect to your gateway`
2. `Review evidence and settings`
3. `Send role-aware follow-up`
4. `Capture device context fast`

Notes:

- this set is suitable as the current high-resolution iPhone portrait baseline
- before final submission, verify the screenshots still match the latest `VeriClaw 爪印` branding and UI copy
- Apple says you can upload between one and ten screenshots, and if the UI is the same across device sizes you can provide only the highest-resolution required set and let App Store Connect scale it down
- the current synchronized launch path excludes the Watch companion, so watchOS screenshots are not part of this submission set

Local material checks:

- `pnpm ios:review:local-check` verifies the required iPhone files are present and that local App Review / ASC values are filled
- `pnpm ios:review:preview` renders the App Review contact metadata into `apps/ios/build/app-store-metadata-preview` so the submission text can be reviewed locally before upload
