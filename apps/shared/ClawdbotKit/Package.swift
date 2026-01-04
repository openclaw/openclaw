// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "ClawdbotKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v15),
    ],
    products: [
        .library(name: "ClawdbotKit", targets: ["ClawdbotKit"]),
        .library(name: "ClawdbotChatUI", targets: ["ClawdbotChatUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.0"),
    ],
    targets: [
        .target(
            name: "ClawdbotKit",
            dependencies: [
                .product(name: "ElevenLabsKit", package: "ElevenLabsKit"),
            ],
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "ClawdbotChatUI",
            dependencies: ["ClawdbotKit"],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "ClawdbotKitTests",
            dependencies: ["ClawdbotKit", "ClawdbotChatUI"],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
