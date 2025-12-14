// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "ClawdisKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v15),
    ],
    products: [
        .library(name: "ClawdisKit", targets: ["ClawdisKit"]),
        .library(name: "ClawdisChatUI", targets: ["ClawdisChatUI"]),
    ],
    targets: [
        .target(
            name: "ClawdisKit",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "ClawdisChatUI",
            dependencies: ["ClawdisKit"],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "ClawdisKitTests",
            dependencies: ["ClawdisKit"],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
