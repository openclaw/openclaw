# App Store metadata (Fastlane deliver)

This directory is used by `fastlane deliver` for App Store Connect text metadata.

## Upload public metadata and App Review attachment

```bash
cd apps/ios
APP_STORE_CONNECT_APP_ID=YOUR_APP_STORE_CONNECT_APP_ID \
DELIVER_METADATA=1 BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.21_ exec fastlane ios metadata release_version:2026.7.2 app_store_revision:1
```

## Release notes and App Review attachment

`pnpm ios:release:upload` stages screenshots and the App Review PDF attachment
after local archive validation. Once Apple processes the IPA, it stages the
saved notes artifact and selects the exact build. Use
[staging recovery](../../VERSIONING.md#staging-recovery) for a post-upload
failure; the `metadata` convenience lane does not upload release notes.

## Optional: include screenshots

```bash
cd apps/ios
DELIVER_METADATA=1 DELIVER_SCREENSHOTS=1 BUNDLE_GEMFILE="$PWD/Gemfile" bundle _4.0.21_ exec fastlane ios metadata release_version:2026.7.2 app_store_revision:1
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
- Release notes come from the reviewed `release-notes.json` artifact generated from Git history since the latest public build. No changelog cut is required.
- Do not check in `release_notes.txt` under locale metadata directories; the metadata lane strips copied release-note files.
- `apps/ios/APP-REVIEW-NOTES-APPLE.md` is rendered to `apps/ios/build/app-review/APP-REVIEW-NOTES.pdf` and uploaded as the App Review attachment when metadata is uploaded.
- The release flow stages saved notes and selects the processed build after uploading the IPA. App Review submission remains manual.
- `privacy_url.txt` is set to `https://openclaw.ai/privacy`.
- If app lookup fails in `deliver`, set one of:
  - `APP_STORE_CONNECT_APP_IDENTIFIER` (bundle ID)
  - `APP_STORE_CONNECT_APP_ID` (numeric App Store Connect app ID, e.g. from `/apps/<id>/...` URL)
- App Review submission is manual. Keep review contact, demo account, and the App Store Connect `Notes` field outside this repo and enter them directly in App Store Connect when submitting for review. Do not add `metadata/review_information/notes.txt`; the lane refuses to upload that field.
