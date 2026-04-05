// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "MullusiKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "MullusiProtocol", targets: ["MullusiProtocol"]),
        .library(name: "MullusiKit", targets: ["MullusiKit"]),
        .library(name: "MullusiChatUI", targets: ["MullusiChatUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.0"),
        .package(url: "https://github.com/gonzalezreal/textual", exact: "0.3.1"),
    ],
    targets: [
        .target(
            name: "MullusiProtocol",
            path: "Sources/MullusiProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "MullusiKit",
            dependencies: [
                "MullusiProtocol",
                .product(name: "ElevenLabsKit", package: "ElevenLabsKit"),
            ],
            path: "Sources/MullusiKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "MullusiChatUI",
            dependencies: [
                "MullusiKit",
                .product(
                    name: "Textual",
                    package: "textual",
                    condition: .when(platforms: [.macOS, .iOS])),
            ],
            path: "Sources/MullusiChatUI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "MullusiKitTests",
            dependencies: ["MullusiKit", "MullusiChatUI"],
            path: "Tests/MullusiKitTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
