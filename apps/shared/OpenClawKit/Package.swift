// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "EasyHubKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "EasyHubProtocol", targets: ["EasyHubProtocol"]),
        .library(name: "EasyHubKit", targets: ["EasyHubKit"]),
        .library(name: "EasyHubChatUI", targets: ["EasyHubChatUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.0"),
        .package(url: "https://github.com/gonzalezreal/textual", exact: "0.3.1"),
    ],
    targets: [
        .target(
            name: "EasyHubProtocol",
            path: "Sources/EasyHubProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "EasyHubKit",
            dependencies: [
                "EasyHubProtocol",
                .product(name: "ElevenLabsKit", package: "ElevenLabsKit"),
            ],
            path: "Sources/EasyHubKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "EasyHubChatUI",
            dependencies: [
                "EasyHubKit",
                .product(
                    name: "Textual",
                    package: "textual",
                    condition: .when(platforms: [.macOS, .iOS])),
            ],
            path: "Sources/EasyHubChatUI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "EasyHubKitTests",
            dependencies: ["EasyHubKit", "EasyHubChatUI"],
            path: "Tests/EasyHubKitTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
