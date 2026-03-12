# Expo App Store Deploy — Full Pipeline Guide

## Build Profiles

Configure in `eas.json`:

```json
{
  "build": {
    "production": {
      "distribution": "store",
      "ios": { "credentialsSource": "remote" },
      "android": { "buildType": "app-bundle" }
    },
    "preview": {
      "distribution": "internal"
    }
  },
  "submit": {
    "production": {
      "ios": { "appleId": "your@email.com", "ascAppId": "APP_ID" },
      "android": { "serviceAccountKeyPath": "./google-service-account.json" }
    }
  }
}
```

## iOS Certificate Management

- First build: EAS manages certificates automatically (interactive)
- Reset credentials: `npx eas-cli credentials --platform ios`
- Provisioning profiles: managed by EAS, no manual Xcode required

## Android Keystore

- First build: EAS generates keystore automatically
- Download backup: `npx eas-cli credentials --platform android`
- Google Play Service Account: create in GCP Console → grant access in Play Console

## App Store Review Checklist

### AI Apps

- Expect 12+ or 17+ age rating requirement
- Microphone: `NSMicrophoneUsageDescription` must be clear and specific

### Required Elements

- External server dependency: handle offline gracefully
- Social login: Apple Sign In required if other social logins present
- Paid apps: Restore Purchases button required
- Demo account + server URL in Review Notes
- All URLs (Privacy, Support, Marketing) must return HTTP 200

### Common Rejection Reasons

1. Missing privacy policy URL
2. Crash on launch (test on real device before submit)
3. Incomplete metadata (screenshots, descriptions)
4. In-app purchases not using StoreKit
5. Data collection not matching App Privacy labels

## Troubleshooting

### Build Failures

- `Install dependencies fails` → Remove native packages from devDependencies
- `Xcode version mismatch` → Set `image` in eas.json build config
- `Out of memory` → Add `NODE_OPTIONS=--max-old-space-size=4096` to env

### Submit Failures

- `ascAppId not allowed empty` → Remove field on first submit, add returned ID after
- `Already submitted this build` → Not an error, previous submission succeeded
- `Invalid credentials` → Re-authenticate: `npx eas-cli login`
