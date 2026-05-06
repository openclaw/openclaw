# GitHub APK Builds

Use the `Android APK Build` workflow in a fork to build downloadable APK artifacts from GitHub.

## Recommended Fork Setup

1. Fork `openclaw/openclaw` to your GitHub owner, for example `brannum/openclaw`.
2. Keep `origin` pointed at your fork and add the official repository as `upstream`.
3. Push these workflow files to the fork's `main` branch.
4. Open **Actions** > **Android APK Build** > **Run workflow**.
5. Download the `openclaw-...-apk` artifact from the completed workflow run.

## Build Choices

- `thirdParty` keeps the SMS and call-log features enabled.
- `play` disables SMS and call-log features for Google Play policy compatibility.
- `debug` builds are easiest for private sideloading and do not need release signing secrets.
- `release` builds require a private Android keystore configured through GitHub Secrets.

## Release Signing Secrets

For signed release APKs, add these repository secrets:

- `OPENCLAW_ANDROID_KEYSTORE_BASE64`: optional base64-encoded keystore file content.
- `OPENCLAW_ANDROID_STORE_FILE`: path where the workflow should write or read the keystore, such as `app/release.keystore`.
- `OPENCLAW_ANDROID_STORE_PASSWORD`: keystore password.
- `OPENCLAW_ANDROID_KEY_ALIAS`: signing key alias.
- `OPENCLAW_ANDROID_KEY_PASSWORD`: signing key password.

Do not commit keystore files or signing passwords to the repository.

## Upstream Updates

The `Upstream Watch` workflow runs daily and compares the fork with `openclaw/openclaw:main`.
When upstream has commits that are not in the fork, it opens or comments on an issue with the current fork SHA, upstream SHA, and merge commands.

This workflow reports source updates only. Dependency update tools such as Dependabot are still separate from upstream fork tracking.
