---
name: expo-appstore-deploy
description: Deploy Expo/React Native apps to Apple App Store and Google Play Store using EAS Build + Submit. Use when building iOS/Android production builds, submitting to app stores, managing certificates/provisioning profiles, or troubleshooting EAS build failures. Triggers on app store deploy, EAS build, production build, submit to store.
---

# Expo App Store Deploy

Full pipeline details in `references/guide.md`.

## Quick Commands

```bash
# iOS: first-time (interactive Apple login required)
npx eas-cli build --platform ios --profile production

# iOS: subsequent builds
npx eas-cli build --platform ios --profile production --non-interactive

# Android
npx eas-cli build --platform android --profile production --non-interactive

# Submit
npx eas-cli submit --platform ios --id <BUILD_ID>
npx eas-cli submit --platform android --id <BUILD_ID>

# Build + submit in one step
npx eas-cli build --platform ios --profile production --auto-submit
```

## Common Failures

| Error                        | Fix                                                  |
| ---------------------------- | ---------------------------------------------------- |
| Install dependencies fails   | Remove native packages from devDependencies          |
| Credentials not set up       | Run first build interactively (no --non-interactive) |
| Apple 2FA invalid code       | Use SMS method, never reuse codes                    |
| ascAppId not allowed empty   | Remove field on first submit, add returned ID after  |
| Already submitted this build | Not an error - previous submission succeeded         |

## Prerequisites

1. Apple Developer Program active
2. Google Play Console + identity verification complete
3. `eas-cli` installed: `npx eas-cli --version`
4. `eas.json` with `projectId` in `app.config.ts`

## App Store Review Tips

- AI apps: expect 12+ or 17+ age rating requirement
- Microphone: NSMicrophoneUsageDescription must be clear
- External server dependency: handle offline gracefully
- Social login: Apple Sign In required if other social logins present
- Paid apps: Restore Purchases button required
- Demo account + server URL required in Review Notes
- All URLs (Privacy, Support, Marketing) must return HTTP 200 before submission
