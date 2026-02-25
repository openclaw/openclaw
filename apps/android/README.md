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

## Macrobenchmark (Startup + Frame Timing)

```bash
cd apps/android
./gradlew :benchmark:connectedDebugAndroidTest
```

Reports are written under:

- `apps/android/benchmark/build/reports/androidTests/connected/`

## Perf CLI (low-noise)

Deterministic startup measurement + hotspot extraction with compact CLI output:

```bash
cd apps/android
./scripts/perf-startup-benchmark.sh
./scripts/perf-startup-hotspots.sh
```

Benchmark script behavior:

- Runs only `StartupMacrobenchmark#coldStartup` (10 iterations).
- Prints median/min/max/COV in one line.
- Writes timestamped snapshot JSON to `apps/android/benchmark/results/`.
- Auto-compares with previous local snapshot (or pass explicit baseline: `--baseline <old-benchmarkData.json>`).

Hotspot script behavior:

- Ensures debug app installed, captures startup `simpleperf` data for `.MainActivity`.
- Prints top DSOs, top symbols, and key app-path clues (Compose/MainActivity/WebView).
- Writes raw `perf.data` path for deeper follow-up if needed.

## Run on a Real Android Phone (USB)

1) On phone, enable **Developer options** + **USB debugging**.
2) Connect by USB and accept the debugging trust prompt on phone.
3) Verify ADB can see the device:

```bash
adb devices -l
```

4) Install + launch debug build:

```bash
pnpm android:install
pnpm android:run
```

If `adb devices -l` shows `unauthorized`, re-plug and accept the trust prompt again.

### USB-only gateway testing (no LAN dependency)

Use `adb reverse` so Android `localhost:18789` tunnels to your laptop `localhost:18789`.

Terminal A (gateway):

```bash
pnpm openclaw gateway --port 18789 --verbose
```

Terminal B (USB tunnel):

```bash
adb reverse tcp:18789 tcp:18789
```

Then in app **Connect → Manual**:

- Host: `127.0.0.1`
- Port: `18789`
- TLS: off

## Hot Reload / Fast Iteration

This app is native Kotlin + Jetpack Compose.

- For Compose UI edits: use Android Studio **Live Edit** on a debug build (works on physical devices; project `minSdk=31` already meets API requirement).
- For many non-structural code/resource changes: use Android Studio **Apply Changes**.
- For structural/native/manifest/Gradle changes: do full reinstall (`pnpm android:run`).
- Canvas web content already supports live reload when loaded from Gateway `__openclaw__/canvas/` (see `docs/platforms/android.md`).

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
