# OpenClaw (iOS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is an **alpha** iOS app that connects to an OpenClaw Gateway as a `role: node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Expect rough edges:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI and onboarding are changing quickly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Background behavior is not stable yet (foreground app is the supported mode right now).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Permissions are opt-in and the app should be treated as sensitive while we harden it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What It Does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Connects to a Gateway over `ws://` / `wss://`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairs a new device (approved from your bot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exposes phone services as node commands (camera, location, photos, calendar, reminders, etc; gated by iOS permissions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provides Talk + Chat surfaces (alpha)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pairing (Recommended Flow)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your Gateway has the `device-pair` plugin installed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. In Telegram, message your bot: `/pair`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Copy the **setup code** message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. On iOS: OpenClaw → Settings → Gateway → paste setup code → Connect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Back in Telegram: `/pair approve`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Build And Run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prereqs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Xcode (current stable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pnpm`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `xcodegen`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From the repo root:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ios:open（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then in Xcode:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Select the `OpenClaw` scheme（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Select a simulator or a connected device（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you're using a personal Apple Development team, you may need to change the bundle identifier in Xcode to a unique value so signing succeeds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Build From CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ios:build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tests（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd apps/ios（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
xcodegen generate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
xcodebuild test -project OpenClaw.xcodeproj -scheme OpenClaw -destination "platform=iOS Simulator,name=iPhone 17"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Shared Code（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `apps/shared/OpenClawKit` contains the shared transport/types used by the iOS app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
