## Clawdbot Node (Android) (internal)

Modern Android node app: connects to the **Gateway WebSocket** (`_clawdbot-gw._tcp`) and exposes **Canvas + Chat + Camera**.

Notes:
- The node keeps the connection alive via a **foreground service** (persistent notification with a Disconnect action).
- Chat always uses the shared session key **`main`** (same session across iOS/macOS/WebChat/Android).
- Supports modern Android only (`minSdk 31`, Kotlin + Jetpack Compose).

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

1) Start the gateway (on your “master” machine):
```bash
pnpm clawdbot gateway --port 18789 --verbose
```

2) In the Android app:
- Open **Settings**
- Either select a discovered gateway under **Discovered Gateways**, or use **Advanced → Manual Gateway** (host + port).

3) Approve pairing (on the gateway machine):
```bash
clawdbot nodes pending
clawdbot nodes approve <requestId>
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
