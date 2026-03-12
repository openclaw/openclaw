# EAS Build (Expo) — Mobile App Deployment

**Target projects:** MAIBOTALKS, MAITUTOR

## Initial Setup (one-time)

```powershell
cd C:\TEST\MAI{project}
npx eas-cli login
npx eas-cli init
```

## Build

```powershell
npx eas-cli build --platform all
```

## Store Submit

```powershell
npx eas-cli submit --platform ios
npx eas-cli submit --platform android
```

## OTA Update (code-only changes)

```powershell
npx eas-cli update --branch production
```

## Pre-Deploy Checklist

- [ ] `app.json` version number incremented
- [ ] `eas.json` profile configuration verified
- [ ] Store certificates/keys configured
- [ ] `npx expo doctor` passes
