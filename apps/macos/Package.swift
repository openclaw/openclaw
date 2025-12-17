// swift-tools-version: 6.2
// Package manifest for the Clawdis macOS companion (menu bar app + CLI + IPC library).

import PackageDescription

let package = Package(
    name: "Clawdis",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "ClawdisIPC", targets: ["ClawdisIPC"]),
        .executable(name: "Clawdis", targets: ["Clawdis"]),
        .executable(name: "ClawdisCLI", targets: ["ClawdisCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(path: "../shared/ClawdisKit"),
        .package(path: "../../Peekaboo/Core/PeekabooCore"),
        .package(path: "../../Peekaboo/Core/PeekabooAutomationKit"),
    ],
    targets: [
        .target(
            name: "ClawdisProtocol",
            dependencies: [],
            path: "Sources/ClawdisProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "ClawdisIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "Clawdis",
            dependencies: [
                "ClawdisIPC",
                "ClawdisProtocol",
                .product(name: "ClawdisKit", package: "ClawdisKit"),
                .product(name: "ClawdisChatUI", package: "ClawdisKit"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "PeekabooBridge", package: "PeekabooCore"),
                .product(name: "PeekabooAutomationKit", package: "PeekabooAutomationKit"),
            ],
            resources: [
                .copy("Resources/Clawdis.icns"),
                .copy("Resources/CanvasA2UI"),
                .copy("Resources/WebChat"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "ClawdisCLI",
            dependencies: [
                "ClawdisIPC",
                "ClawdisProtocol",
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "ClawdisIPCTests",
            dependencies: ["ClawdisIPC", "Clawdis", "ClawdisProtocol"],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
        .testTarget(
            name: "ClawdisCLITests",
            dependencies: ["ClawdisCLI"],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
