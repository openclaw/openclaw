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

## Notes

- Locale files live under `metadata/en-US/`.
- `release_notes.txt` is generated from `apps/ios/CHANGELOG.md`; after changelog updates, run `pnpm ios:version:sync`.
- Release notes resolve from `## <pinned iOS version>` first, then fall back to `## Unreleased` while a TestFlight train is still in progress.
- When starting a new production release train, pin the iOS version first with `pnpm ios:version:pin -- --from-gateway`.
- `privacy_url.txt` is set to `https://openclaw.ai/privacy`.
- If app lookup fails in `deliver`, set one of:
  - `ASC_APP_IDENTIFIER` (bundle ID)
  - `ASC_APP_ID` (numeric App Store Connect app ID, e.g. from `/apps/<id>/...` URL)
- For first app versions, include review contact files under `metadata/review_information/`:
  - `first_name.txt`
  - `last_name.txt`
  - `email_address.txt`
  - `phone_number.txt` (E.164-ish, e.g. `+1 415 555 0100`)
