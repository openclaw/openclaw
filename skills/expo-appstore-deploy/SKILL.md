---
name: expo-appstore-deploy
description: "Deploy Expo/React Native apps to Apple App Store and Google Play Store using EAS Build + Submit. Use when: building iOS/Android production builds, submitting to app stores, managing certificates/provisioning profiles, troubleshooting EAS build failures. Triggers: 'app store deploy', '앱스토어 배포', 'EAS build', 'production build', 'submit to store', '스토어 제출', 'iOS build', 'Android build', 'EAS submit', '앱 빌드'. NOT for: development builds, Expo Go testing, web-only deploys."
---

# Expo App Store Deploy

Full pipeline details: `references/guide.md`

## Quick Commands

```bash
# iOS build (first time: interactive for Apple login)
npx eas-cli build --platform ios --profile production

# iOS subsequent (non-interactive)
npx eas-cli build --platform ios --profile production --non-interactive

# Android
npx eas-cli build --platform android --profile production --non-interactive

# Submit
npx eas-cli submit --platform ios --id <BUILD_ID>
npx eas-cli submit --platform android --id <BUILD_ID>

# Build + submit combined
npx eas-cli build --platform ios --profile production --auto-submit
```

## Prerequisites

1. Apple Developer Program active
2. Google Play Console + identity verification
3. `eas-cli` installed: `npx eas-cli --version`
4. `eas.json` with `projectId` in `app.config.ts`

## Common Failures

| Error                      | Fix                                                    |
| -------------------------- | ------------------------------------------------------ |
| Install dependencies fails | Remove native packages from devDependencies            |
| Credentials not set up     | Run first build interactively (no `--non-interactive`) |
| Apple 2FA invalid code     | Use SMS method, never reuse codes                      |
| ascAppId not allowed empty | Remove field on first submit, add returned ID after    |

## App Store Review Tips

See `references/guide.md` for detailed review guidelines.

Key points: AI apps get 12+/17+ age rating, Apple Sign In required if other social logins present, all URLs must return HTTP 200 before submission.
