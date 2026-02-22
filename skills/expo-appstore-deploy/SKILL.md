---
name: expo-appstore-deploy
description: Deploy Expo/React Native apps to Apple App Store and Google Play Store using EAS Build + Submit. Use when building iOS/Android production builds, submitting to app stores, managing certificates/provisioning profiles, or troubleshooting EAS build failures. Triggers on "앱스토어 배포", "App Store 제출", "EAS build", "production build", "앱 배포", "스토어 제출".
---

# Expo App Store Deploy

## Prerequisites Check

Before starting, verify:

1. Apple Developer Program active (check `https://developer.apple.com/account`)
2. Google Play Console account + identity verification complete
3. `eas-cli` installed: `npx eas-cli --version`
4. EAS project linked: `eas.json` exists with `projectId` in `app.config.ts`

## iOS Deploy Pipeline

### First-Time Setup (Interactive Required)

```bash
# Must run interactive for Apple login + certificate generation
npx eas-cli build --platform ios --profile production
# → Apple ID + password + 2FA (prefer SMS if device auth fails)
# → Auto-generates Distribution Certificate + Provisioning Profile
```

### Subsequent Builds (Non-Interactive OK)

```bash
npx eas-cli build --platform ios --profile production --non-interactive
```

### Submit to App Store Connect

```bash
# After build succeeds
npx eas-cli submit --platform ios --id <BUILD_ID>

# Or build + submit in one command
npx eas-cli build --platform ios --profile production --auto-submit
```

## Critical Config

### app.config.ts — Must Include

```typescript
ios: {
  infoPlist: {
    ITSAppUsesNonExemptEncryption: false,  // Skips export compliance prompt
    // Add all permission descriptions
  },
}
```

### eas.json — Production Profile

```json
{
  "build": {
    "production": {
      "autoIncrement": true,
      "node": "22.17.1",
      "env": { "EAS_BUILD_NO_EXPO_GO_WARNING": "true" },
      "ios": { "image": "latest" },
      "android": { "buildType": "app-bundle" }
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleTeamId": "<TEAM_ID>",
        "ascAppId": "<ASC_APP_ID>"
      }
    }
  }
}
```

## Known Failure Patterns

### "Install dependencies" Build Failure

**Cause:** Native binary packages (sharp, canvas, bcrypt, node-gyp deps) in devDependencies.
**Fix:** Remove from devDependencies — EAS installs all deps including dev.

```bash
npm uninstall <package> --save-dev
```

### "Credentials are not set up" (non-interactive)

**Cause:** First build requires interactive Apple login for certificate generation.
**Fix:** Run first build without `--non-interactive`. After certs are stored on EAS, non-interactive works.

### Apple 2FA "Invalid code"

**Cause:** Device auth code is single-use and expires in ~30 seconds.
**Fix:** Switch to `sms` method. Don't reuse codes.

### "ascAppId is not allowed to be empty"

**Cause:** Empty string in eas.json submit config.
**Fix:** Remove `ascAppId` field entirely for first submit (auto-creates app), then add the returned ID.

## Android Deploy Pipeline

### Build

```bash
npx eas-cli build --platform android --profile production --non-interactive
```

### Submit

```bash
npx eas-cli submit --platform android --id <BUILD_ID>
```

Requires: Google Play Console identity verification complete + service account JSON key.

## Post-Submit Checklist

1. App Store Connect → Processing complete (10-30 min)
2. TestFlight test (optional but recommended)
3. Add metadata: screenshots, description, keywords, categories
4. Set pricing (paid/free)
5. Provide review demo credentials in Review Notes
6. Submit for review (1-7 days typical)

## App Store Review Tips

- AI apps: Apple may require 12+ or 17+ age rating
- Microphone permission: clear description required in NSMicrophoneUsageDescription
- External server dependency: must handle offline/disconnected state gracefully
- If social login exists: Apple Sign In is mandatory
- "Restore Purchases" button required for paid apps
- Privacy labels must be accurate
- Demo account/URL for reviewers is critical for apps needing server connection
