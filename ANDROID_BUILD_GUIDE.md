# Quick Start: Build Android App with GitHub Actions

## Overview

This repository now includes a GitHub Actions workflow that automatically builds the Android app, bypassing the ARM64 SDK limitation.

## Build the App

### Option 1: Push to Trigger Automatic Build

```bash
# Push your changes (workflow triggers automatically on Android app changes)
git push origin main

# Or create a pull request
gh pr create --title "Add Android build workflow" --body "Enables CI builds on GitHub Actions"
```

### Option 2: Manual Trigger

```bash
# Trigger the workflow manually
gh workflow run android-build.yml

# Or open in browser to trigger
gh workflow view android-build.yml --web
```

### Option 3: Create a Branch and Pull Request

```bash
# Create a new branch
git checkout -b add-android-workflow

# Push the branch
git push -u origin add-android-workflow

# Create a pull request
gh pr create --title "Add GitHub Actions for Android builds" \
  --body "Automates Android builds on GitHub Actions, solving ARM64 SDK limitations."

# This will trigger the workflow automatically
```

## Monitor and Download

### Watch Build Progress

```bash
# View latest workflow run
gh run list --workflow=android-build.yml

# View specific run details
gh run view <run-id>

# Watch in real-time
gh run watch --log --interval=5
```

### Download APK Artifacts

```bash
# List artifacts from latest run
gh run view <run-id>

# Download all artifacts
gh run download <run-id>

# Download specific artifact
gh run download <run-id> -n openclaw-android-debug-apk
```

### Alternative: Download via Browser

```bash
# Open workflow in browser
gh workflow view android-build.yml --web

# Then download artifacts from the Actions tab
```

## Workflow Details

**File:** `.github/workflows/android-build.yml`

- **Triggers:** Push to main/master, PR for Android changes, or manual dispatch
- **Builds:** Debug APK (7 MB) + Release APK
- **Artifact Retention:** 30 days (Debug) / 90 days (Release)
- **Platform:** GitHub Actions (Ubuntu with x86_64 Android SDK)

## Example Full Workflow

```bash
# 1. Check git status
git status

# 2. Create and push branch
git checkout -b ci-android-build
git add .github/workflows/
git commit -m "Add GitHub Actions for Android builds"
git push -u origin ci-android-build

# 3. Create PR (triggers build)
gh pr create --title "CI: Add Android build workflow" \
  --body "Uses GitHub Actions x86-64 runners to build Android app, bypassing ARM64 SDK limitations."

# 4. Watch the build
gh run watch --log --workflow=android-build.yml

# 5. Download APK when complete
gh run download <run-id> -n openclaw-android-debug-apk
```

## Next Steps

After successful build:

- Install APK on Android device: `adb install openclaw-*.apk`
- Or transfer APK to device and install manually
- Refer to `docs/platforms/android.md` for pairing instructions

## Troubleshooting

### Workflow not triggering

- Check file paths: Changes must be in `apps/android/` directory
- Verify workflow file exists: `cat .github/workflows/android-build.yml`

### Build fails

- Check logs: `gh run view <run-id> --log`
- Common issue: compileSdk mismatch (dependencies require specific version)

### Can't download artifacts

- Verify run completed successfully: `gh run list --workflow=android-build.yml`
- Check browser: `gh workflow view android-build.yml --web`
