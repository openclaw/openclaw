# App Store metadata (Fastlane deliver)

This directory is used by `fastlane deliver` for App Store Connect text metadata.

## Upload metadata only

```bash
cd apps/ios
ASC_APP_ID=YOUR_APP_STORE_CONNECT_APP_ID \
DELIVER_METADATA=1 fastlane ios metadata
```

## Optional: include screenshots

```bash
cd apps/ios
DELIVER_METADATA=1 DELIVER_SCREENSHOTS=1 fastlane ios metadata
```

Current screenshot source set:

- `apps/ios/screenshots/session-2026-03-07/*.png`
- documented in `apps/ios/screenshots/README.md`

## Auth

The `ios metadata` lane uses App Store Connect API key auth from `apps/ios/fastlane/.env`:

- Keychain-backed (recommended on macOS):
  - `ASC_KEY_ID`
  - `ASC_ISSUER_ID`
  - `ASC_KEYCHAIN_SERVICE` (default: `openclaw-asc-key`)
  - `ASC_KEYCHAIN_ACCOUNT` (default: current user)
- File/path fallback:
  - `ASC_KEY_ID`
  - `ASC_ISSUER_ID`
  - `ASC_KEY_PATH`

Or set `APP_STORE_CONNECT_API_KEY_PATH`.

## App Review contact injection

The repo keeps templated review-contact files under `metadata/review_information/`.
Before `deliver` runs with `DELIVER_METADATA=1`, Fastlane stages this metadata into
`apps/ios/build/app-store-metadata` and replaces these tokens from local env vars:

- `IOS_APP_REVIEW_FIRST_NAME`
- `IOS_APP_REVIEW_LAST_NAME`
- `IOS_APP_REVIEW_EMAIL`
- `IOS_APP_REVIEW_PHONE`
- `IOS_APP_REVIEW_NOTES_APPEND`

`IOS_APP_REVIEW_NOTES_APPEND` should contain the submission-specific pairing,
gateway, or demo-account instructions that Apple needs to exercise the full app.

To preview the injected review-information files locally before upload:

```bash
pnpm ios:review:preview
```

To run the full submission-side Apple gate on the release Mac:

```bash
pnpm release:apple:submit-check
```

This writes the staged local preview to:

```bash
apps/ios/build/app-store-metadata-preview
```

## Notes

- Locale files live under `metadata/en-US/`.
- `marketing_url.txt` points at the GitHub launch surface for VeriClaw 爪印.
- `privacy_url.txt` points at the repo-root `PRIVACY.md`.
- `support_url.txt` points at the repo-root `SUPPORT.md`.
- If app lookup fails in `deliver`, set one of:
  - `ASC_APP_IDENTIFIER` (bundle ID)
  - `ASC_APP_ID` (numeric App Store Connect app ID, e.g. from `/apps/<id>/...` URL)
- For first app versions, include review contact files under `metadata/review_information/`:
  - `first_name.txt`
  - `last_name.txt`
  - `email_address.txt`
  - `phone_number.txt` (E.164-ish, e.g. `+1 415 555 0100`)
  - store the real values in `apps/ios/fastlane/.env`, not in git
