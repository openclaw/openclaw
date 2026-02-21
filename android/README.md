# OpenClaw Android Node

The official OpenClaw Android node app with **Limitless pendant** BLE audio support.

## What It Does

- **Chat with your AI** — Telegram-style UI, messages over WebSocket to your OpenClaw gateway
- **Limitless pendant support** — BLE audio streaming from Limitless pendants (Opus codec)
- **Omi DevKit support** — Also works with Omi BLE audio devices
- **MimiClaw/ESP32 ready** — Device discovery for ESP32-S3 MimiClaw units
- **Phone mic fallback** — No pendant? Stream audio from your phone mic
- **Location context** — Optional GPS sharing for location-aware responses
- **Background service** — Keeps streaming when the app is backgrounded

## Quick Start

This app ships **hardcoded** to connect to a specific OpenClaw gateway. To use with your own:

1. Edit `lib/config/zeke_config.dart` with your gateway URL
2. Build: `flutter build apk --debug`
3. Install on your Android device
4. Open the app — it connects automatically

## Supported Devices

| Device | Type | Status |
|--------|------|--------|
| Limitless Pendant | BLE audio wearable | ✅ Full support |
| Omi DevKit2 | BLE audio wearable | ✅ Full support |
| MimiClaw ESP32 | WiFi/BLE microcontroller | 🔜 Coming soon |
| Phone Microphone | Built-in | ✅ Fallback mode |

## Architecture

```
[Limitless Pendant] --BLE--> [Android App] --WSS--> [OpenClaw Gateway]
[Phone Mic]         -------> [Android App] --WSS--> [OpenClaw Gateway]
```

## Build

```bash
cd android
flutter pub get
flutter build apk --debug
```

APK output: `build/app/outputs/flutter-apk/app-debug.apk`

## License

MIT — Same as OpenClaw
