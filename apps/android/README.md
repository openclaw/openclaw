## OpenClaw Node (Android) (internal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Modern Android node app: connects to the **Gateway WebSocket** (`_openclaw-gw._tcp`) and exposes **Canvas + Chat + Camera**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The node keeps the connection alive via a **foreground service** (persistent notification with a Disconnect action).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chat always uses the shared session key **`main`** (same session across iOS/macOS/WebChat/Android).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Supports modern Android only (`minSdk 31`, Kotlin + Jetpack Compose).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open in Android Studio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Open the folder `apps/android`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Build / Run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd apps/android（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./gradlew :app:assembleDebug（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./gradlew :app:installDebug（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./gradlew :app:testDebugUnitTest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`gradlew` auto-detects the Android SDK at `~/Library/Android/sdk` (macOS default) if `ANDROID_SDK_ROOT` / `ANDROID_HOME` are unset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Connect / Pair（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1) Start the gateway (on your “master” machine):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm openclaw gateway --port 18789 --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2) In the Android app:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Open **Settings**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Either select a discovered gateway under **Discovered Gateways**, or use **Advanced → Manual Gateway** (host + port).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3) Approve pairing (on the gateway machine):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More details: `docs/platforms/android.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discovery:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Android 13+ (`API 33+`): `NEARBY_WIFI_DEVICES`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Android 12 and below: `ACCESS_FINE_LOCATION` (required for NSD scanning)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Foreground service notification (Android 13+): `POST_NOTIFICATIONS`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Camera:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `CAMERA` for `camera.snap` and `camera.clip`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `RECORD_AUDIO` for `camera.clip` when `includeAudio=true`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
