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
    ],
    targets: [
        .target(
            name: "ClawdisIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]
        ),
        .executableTarget(
            name: "Clawdis",
            dependencies: [
                "ClawdisIPC",
                .product(name: "AsyncXPCConnection", package: "AsyncXPCConnection"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]
        ),
        .executableTarget(
            name: "ClawdisCLI",
            dependencies: [
                "ClawdisIPC",
                .product(name: "AsyncXPCConnection", package: "AsyncXPCConnection"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]
        ),
        .testTarget(
            name: "ClawdisIPCTests",
            dependencies: ["ClawdisIPC"],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]
        ),
    ]
)
