// swift-tools-version: 6.2
// Package manifest for the Clawdbot macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "Clawdbot",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "ClawdbotIPC", targets: ["ClawdbotIPC"]),
        .executable(name: "Clawdbot", targets: ["Clawdbot"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.8.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(path: "../shared/ClawdbotKit"),
        .package(path: "../../Swabble"),
        .package(path: "../../Peekaboo/Core/PeekabooCore"),
        .package(path: "../../Peekaboo/Core/PeekabooAutomationKit"),
    ],
    targets: [
        .target(
            name: "ClawdbotProtocol",
            dependencies: [],
            path: "Sources/ClawdbotProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "ClawdbotIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "Clawdbot",
            dependencies: [
                "ClawdbotIPC",
                "ClawdbotProtocol",
                .product(name: "ClawdbotKit", package: "ClawdbotKit"),
                .product(name: "ClawdbotChatUI", package: "ClawdbotKit"),
                .product(name: "SwabbleKit", package: "swabble"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "PeekabooBridge", package: "PeekabooCore"),
                .product(name: "PeekabooAutomationKit", package: "PeekabooAutomationKit"),
            ],
            exclude: [
                "Resources/Info.plist",
            ],
            resources: [
                .copy("Resources/Clawdbot.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "ClawdbotIPCTests",
            dependencies: [
                "ClawdbotIPC",
                "Clawdbot",
                "ClawdbotProtocol",
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
