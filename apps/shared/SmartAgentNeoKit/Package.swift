// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "SmartAgentNeoKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "SmartAgentNeoProtocol", targets: ["SmartAgentNeoProtocol"]),
        .library(name: "SmartAgentNeoKit", targets: ["SmartAgentNeoKit"]),
        .library(name: "SmartAgentNeoChatUI", targets: ["SmartAgentNeoChatUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.0"),
        .package(url: "https://github.com/gonzalezreal/textual", exact: "0.3.1"),
    ],
    targets: [
        .target(
            name: "SmartAgentNeoProtocol",
            path: "Sources/SmartAgentNeoProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "SmartAgentNeoKit",
            dependencies: [
                "SmartAgentNeoProtocol",
                .product(name: "ElevenLabsKit", package: "ElevenLabsKit"),
            ],
            path: "Sources/SmartAgentNeoKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "SmartAgentNeoChatUI",
            dependencies: [
                "SmartAgentNeoKit",
                .product(
                    name: "Textual",
                    package: "textual",
                    condition: .when(platforms: [.macOS, .iOS])),
            ],
            path: "Sources/SmartAgentNeoChatUI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "SmartAgentNeoKitTests",
            dependencies: ["SmartAgentNeoKit", "SmartAgentNeoChatUI"],
            path: "Tests/SmartAgentNeoKitTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
