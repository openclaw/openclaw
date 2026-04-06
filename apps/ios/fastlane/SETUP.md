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
ASC_APP_IDENTIFIER=ai.openclaw.client
# or
ASC_APP_ID=YOUR_APP_STORE_CONNECT_APP_ID
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

ASC auth is only required when:

- uploading to TestFlight
- auto-resolving the next build number from App Store Connect

If you pass `--build-number` to `pnpm ios:beta:archive`, the local archive path does not need ASC auth.

Archive locally without upload:

```bash
pnpm ios:beta:archive
```

Upload to TestFlight:

```bash
pnpm ios:beta
```

Direct Fastlane entry point:

```bash
cd apps/ios
fastlane ios beta
```

Maintainer recovery path for a fresh clone on the same Mac:

1. Reuse the existing Keychain-backed ASC key on that machine.
2. Restore or recreate `apps/ios/fastlane/.env` so it contains the non-secret variables:

```bash
ASC_KEY_ID=YOUR_KEY_ID
ASC_ISSUER_ID=YOUR_ISSUER_ID
ASC_KEYCHAIN_SERVICE=openclaw-asc-key
ASC_KEYCHAIN_ACCOUNT=YOUR_MAC_USERNAME
```

3. Re-run auth validation:

```bash
cd apps/ios
fastlane ios auth_check
```

4. Set the official/TestFlight relay URL before release:

```bash
export OPENCLAW_PUSH_RELAY_BASE_URL=https://relay.example.com
```

5. Upload:

```bash
pnpm ios:beta
```

Quick verification after upload:

- confirm `apps/ios/build/beta/OpenClaw-<version>.ipa` exists
- confirm Fastlane prints `Uploaded iOS beta: version=<version> short=<short> build=<build>`
- remember that TestFlight processing can take a few minutes after the upload succeeds

Versioning rules:

- Root `package.json.version` is the single source of truth for iOS
- Use `YYYY.M.D` for stable versions and `YYYY.M.D-beta.N` for beta versions
- Fastlane stamps `CFBundleShortVersionString` to `YYYY.M.D`
- Fastlane resolves `CFBundleVersion` as the next integer TestFlight build number for that short version
- The beta flow regenerates `apps/ios/OpenClaw.xcodeproj` from `apps/ios/project.yml` before archiving
- Local beta signing uses a temporary generated xcconfig and leaves local development signing overrides untouched
