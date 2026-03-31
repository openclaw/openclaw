# OpenClaw macOS app — Xcode setup

This folder is already a **Swift Package** for the macOS app. You do **not** need to generate or maintain a legacy `.xcodeproj` by hand.

## Open in Xcode

From this folder:

```bash
./open-in-xcode.sh
```

Or manually:
- Open Xcode
- **File → Open...**
- Select `Package.swift` in this folder

Xcode will load the Swift package and expose the package products/targets.

## Main targets

- **OpenClaw** — macOS app target
- **OpenClawMacCLI** — CLI executable
- **OpenClawIPC** — IPC library
- **OpenClawDiscovery** — discovery library
- **OpenClawIPCTests** — tests

## Build the app in Xcode

1. Open the package in Xcode
2. Choose the **OpenClaw** scheme
3. Choose **My Mac** as the destination
4. Build / Run

## Notes

- `swift build -c debug` succeeds from this folder, so the package is structurally valid.
- Local package dependencies are resolved relative to the repo:
  - `../shared/OpenClawKit`
  - `../../Swabble`
- App resources already exist in:
  - `Sources/OpenClaw/Resources/OpenClaw.icns`
  - `Sources/OpenClaw/Resources/DeviceModels`
  - `Sources/OpenClaw/Resources/Info.plist`

## If you specifically need a standalone `.xcodeproj`

Modern SwiftPM/Xcode workflows no longer rely on `swift package generate-xcodeproj`.
The supported approach is opening `Package.swift` directly in Xcode.

If you still want a handcrafted `.xcodeproj`, that can be created, but it is more fragile and usually worse than the native Swift Package workflow.
