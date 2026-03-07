# fastlane setup (OpenClaw iOS)

Install:

```bash
brew install fastlane
```

Create an App Store Connect API key:

- App Store Connect → Users and Access → Keys → App Store Connect API → Generate API Key
- Download the `.p8`, note the **Issuer ID** and **Key ID**

Recommended (macOS): store the private key in Keychain and write non-secret vars:

```bash
scripts/ios-asc-keychain-setup.sh \
  --key-path /absolute/path/to/AuthKey_XXXXXXXXXX.p8 \
  --issuer-id YOUR_ISSUER_ID \
  --write-env
```

This writes these auth variables in `apps/ios/fastlane/.env`:

```bash
ASC_KEY_ID=YOUR_KEY_ID
ASC_ISSUER_ID=YOUR_ISSUER_ID
ASC_KEYCHAIN_SERVICE=openclaw-asc-key
ASC_KEYCHAIN_ACCOUNT=YOUR_MAC_USERNAME
```

Optional app targeting variables (helpful if Fastlane cannot auto-resolve app by bundle):

```bash
ASC_APP_IDENTIFIER=ai.openclaw.ios
# or
ASC_APP_ID=6760218713
```

File-based fallback (CI/non-macOS):

```bash
ASC_KEY_ID=YOUR_KEY_ID
ASC_ISSUER_ID=YOUR_ISSUER_ID
ASC_KEY_PATH=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
```

Code signing variable (optional in `.env`):

```bash
IOS_DEVELOPMENT_TEAM=YOUR_TEAM_ID
```

Tip: run `scripts/ios-team-id.sh` from repo root to print a Team ID for `.env`. The helper prefers the canonical OpenClaw team (`Y5PE65HELJ`) when present locally; otherwise it prefers the first non-personal team from your Xcode account (then personal team if needed). Fastlane uses this helper automatically if `IOS_DEVELOPMENT_TEAM` is missing.

Validate auth:

```bash
cd apps/ios
fastlane ios auth_check
```

Run:

```bash
cd apps/ios
fastlane beta
```
