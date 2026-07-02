# App Store metadata (Fastlane deliver)

This directory is used by `fastlane deliver` for App Store Connect text metadata.

## Upload public metadata and App Review attachment

```bash
cd apps/ios
APP_STORE_CONNECT_APP_ID=YOUR_APP_STORE_CONNECT_APP_ID \
DELIVER_METADATA=1 fastlane ios metadata release_version:2026.6.11
```

## Release notes and App Review attachment

`pnpm ios:release:upload` uses this mode before archiving so the editable App Store version has current release notes and the App Review PDF attachment without rewriting all metadata:

```bash
cd apps/ios
DELIVER_RELEASE_NOTES=1 fastlane ios metadata release_version:2026.6.11
```

## Optional: include screenshots

```bash
cd apps/ios
DELIVER_METADATA=1 DELIVER_SCREENSHOTS=1 fastlane ios metadata release_version:2026.6.11
```

## Auth

The `ios metadata` lane uses App Store Connect API key auth from `apps/ios/fastlane/.env`:

- Keychain-backed (recommended on macOS):
  - `APP_STORE_CONNECT_KEY_ID`
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_KEYCHAIN_SERVICE` (default: `openclaw-app-store-connect-key`)
  - `APP_STORE_CONNECT_KEYCHAIN_ACCOUNT` (default: current user)
- File/path fallback:
  - `APP_STORE_CONNECT_KEY_ID`
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_KEY_PATH`

Or set `APP_STORE_CONNECT_API_KEY_PATH`.

## Notes

- Locale files live under `metadata/<locale>/`, for example `metadata/en-US/` and `metadata/sv-SE/`. Each locale directory should use the public metadata filenames consumed by the `ios metadata` lane.
- `release_notes.txt` is generated from `apps/ios/CHANGELOG.md`; after changelog updates, run `pnpm ios:version:sync -- --version <release-version>`.
- `apps/ios/APP-REVIEW-NOTES.md` is rendered to `apps/ios/build/app-review/APP-REVIEW-NOTES.pdf` and uploaded as the App Review attachment when metadata is uploaded.
- Release notes resolve from `## <release version>` first, then fall back to `## Unreleased` while a TestFlight train is still in progress.
- When starting a new production release train, sync metadata with `pnpm ios:version:sync -- --version <release-version>`.
- The release upload flow uploads release notes, screenshots, and the App Review PDF attachment before the IPA, and never submits for App Review.
- `privacy_url.txt` is set to `https://openclaw.ai/privacy`.
- If app lookup fails in `deliver`, set one of:
  - `APP_STORE_CONNECT_APP_IDENTIFIER` (bundle ID)
  - `APP_STORE_CONNECT_APP_ID` (numeric App Store Connect app ID, e.g. from `/apps/<id>/...` URL)
- App Review submission is manual. Keep review contact, demo account, and the App Store Connect `Notes` field outside this repo and enter them directly in App Store Connect when submitting for review. Do not add `metadata/review_information/notes.txt`; the lane refuses to upload that field.
