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
        .package(url: "https://github.com/ChimeHQ/AsyncXPCConnection", from: "1.3.0"),
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
    ],
    targets: [
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
                .product(name: "AsyncXPCConnection", package: "AsyncXPCConnection"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            resources: [
                .copy("Resources/Clawdis.icns"),
                .copy("Resources/WebChat"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "ClawdisCLI",
            dependencies: [
                "ClawdisIPC",
                .product(name: "AsyncXPCConnection", package: "AsyncXPCConnection"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "ClawdisIPCTests",
            dependencies: ["ClawdisIPC", "Clawdis"],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
