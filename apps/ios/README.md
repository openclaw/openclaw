# ClawdisKit (iOS)

Internal-only SwiftUI app scaffold.

## Lint/format (required)
```bash
brew install swiftformat swiftlint
```

## Generate the Xcode project
```bash
cd apps/ios
xcodegen generate
open ClawdisNode.xcodeproj
```

## Shared packages
- `../shared/ClawdisKit` — shared types/constants used by iOS (and later macOS bridge + gateway routing).
