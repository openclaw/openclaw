# fastlane setup (VeriClaw 爪印 iOS)

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
ASC_APP_IDENTIFIER=ai.vericlaw.client
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

App Review contact variables for metadata submission:

```bash
IOS_APP_REVIEW_FIRST_NAME=YOUR_FIRST_NAME
IOS_APP_REVIEW_LAST_NAME=YOUR_LAST_NAME
IOS_APP_REVIEW_EMAIL=YOUR_REVIEW_EMAIL
IOS_APP_REVIEW_PHONE=+1 415 555 0101
IOS_APP_REVIEW_NOTES_APPEND=PAIRING_OR_DEMO_ACCOUNT_DETAILS_FOR_APP_REVIEW
```

The `fastlane ios metadata` lane stages `apps/ios/fastlane/metadata` into
`apps/ios/build/app-store-metadata` and injects those four values into the
templated `review_information/*.txt` files locally. Contact details are required.
`IOS_APP_REVIEW_NOTES_APPEND` is strongly recommended for this app because App Review
will likely need pairing or demo-gateway details to exercise the full flow.
Real review details do not need to live in git.

Local preflight before metadata upload:

```bash
pnpm ios:review:local-check
```

Render the local App Review metadata exactly as it will be staged:

```bash
pnpm ios:review:preview
```

Preview output path:

```bash
apps/ios/build/app-store-metadata-preview
```

Tip: run `scripts/ios-team-id.sh` from repo root to print a Team ID for `.env`. The helper prefers the configured release team when it is available locally; if that team has changed and exactly one other non-free team is visible in Xcode, it falls back to that team automatically. Fastlane uses this helper automatically if `IOS_DEVELOPMENT_TEAM` is missing.

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

Upload metadata (and optionally screenshots):

```bash
cd apps/ios
DELIVER_METADATA=1 fastlane ios metadata
```

Versioning rules:

- Root `package.json.version` is the single source of truth for iOS
- Use `YYYY.M.D` for stable versions and `YYYY.M.D-beta.N` for beta versions
- Fastlane stamps `CFBundleShortVersionString` to `YYYY.M.D`
- Fastlane resolves `CFBundleVersion` as the next integer TestFlight build number for that short version
- The beta flow regenerates `apps/ios/OpenClaw.xcodeproj` from `apps/ios/project.yml` before archiving
- Local beta signing uses a temporary generated xcconfig and leaves local development signing overrides untouched
