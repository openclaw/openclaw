## OpenClaw Android App

Status: **extremely alpha**. The app is actively being rebuilt from the ground up.

### Rebuild Checklist

- [x] New 4-step onboarding flow
- [x] Connect tab with `Setup Code` + `Manual` modes
- [x] Encrypted persistence for gateway setup/auth state
- [x] Chat UI restyled
- [x] Settings UI restyled and de-duplicated (gateway controls moved to Connect)
- [ ] QR code scanning in onboarding
- [ ] Performance improvements
- [ ] Streaming support in chat UI
- [ ] Request camera/location and other permissions in onboarding/settings flow
- [ ] Push notifications for gateway/chat status updates
- [ ] Security hardening (biometric lock, token handling, safer defaults)
- [ ] Voice tab full functionality
- [ ] Screen tab full functionality
- [ ] Full end-to-end QA and release hardening

## Open in Android Studio

- Open the folder `apps/android`.

## Build / Run

```bash
cd apps/android
./gradlew :app:assembleDebug
./gradlew :app:installDebug
./gradlew :app:testDebugUnitTest
```

`gradlew` auto-detects the Android SDK at `~/Library/Android/sdk` (macOS default) if `ANDROID_SDK_ROOT` / `ANDROID_HOME` are unset.

## Connect / Pair

1) Start the gateway (on your main machine):

```bash
pnpm openclaw gateway --port 18789 --verbose
```

2) In the Android app:

- Open the **Connect** tab.
- Use **Setup Code** or **Manual** mode to connect.

3) Approve pairing (on the gateway machine):

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

More details: `docs/platforms/android.md`.

## Permissions

- Discovery:
  - Android 13+ (`API 33+`): `NEARBY_WIFI_DEVICES`
  - Android 12 and below: `ACCESS_FINE_LOCATION` (required for NSD scanning)
- Foreground service notification (Android 13+): `POST_NOTIFICATIONS`
- Camera:
  - `CAMERA` for `camera.snap` and `camera.clip`
  - `RECORD_AUDIO` for `camera.clip` when `includeAudio=true`

## Contributions

This Android app is currently being rebuilt.
Maintainer: @obviyus. For issues/questions/contributions, please open an issue or reach out on Discord.
