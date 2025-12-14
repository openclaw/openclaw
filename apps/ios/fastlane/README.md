# fastlane (Clawdis iOS)

Install fastlane (recommended via Homebrew):

```bash
brew install fastlane
```

Configure App Store Connect auth:

- Recommended: set `ASC_KEY_PATH` to the downloaded `.p8` path + set `ASC_KEY_ID` and `ASC_ISSUER_ID`.
- Alternative: set `APP_STORE_CONNECT_API_KEY_PATH` to a JSON key file path.
- Alternative: set `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_CONTENT` (base64 p8).

Common lanes:

```bash
cd apps/ios
fastlane beta

# Upload metadata/screenshots only when explicitly enabled:
DELIVER_METADATA=1 fastlane metadata
DELIVER_METADATA=1 DELIVER_SCREENSHOTS=1 fastlane metadata
```
