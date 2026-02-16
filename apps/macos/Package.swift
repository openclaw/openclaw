// swift-tools-version: 6.2
// Package manifest for the SmartAgentNeo macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "SmartAgentNeo",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "SmartAgentNeoIPC", targets: ["SmartAgentNeoIPC"]),
        .library(name: "SmartAgentNeoDiscovery", targets: ["SmartAgentNeoDiscovery"]),
        .executable(name: "SmartAgentNeo", targets: ["SmartAgentNeo"]),
        .executable(name: "smart-agent-neo-mac", targets: ["SmartAgentNeoMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.8.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(url: "https://github.com/steipete/Peekaboo.git", branch: "main"),
        .package(path: "../shared/SmartAgentNeoKit"),
        .package(path: "../../Swabble"),
    ],
    targets: [
        .target(
            name: "SmartAgentNeoIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "SmartAgentNeoDiscovery",
            dependencies: [
                .product(name: "SmartAgentNeoKit", package: "SmartAgentNeoKit"),
            ],
            path: "Sources/SmartAgentNeoDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "SmartAgentNeo",
            dependencies: [
                "SmartAgentNeoIPC",
                "SmartAgentNeoDiscovery",
                .product(name: "SmartAgentNeoKit", package: "SmartAgentNeoKit"),
                .product(name: "SmartAgentNeoChatUI", package: "SmartAgentNeoKit"),
                .product(name: "SmartAgentNeoProtocol", package: "SmartAgentNeoKit"),
                .product(name: "SwabbleKit", package: "swabble"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "PeekabooBridge", package: "Peekaboo"),
                .product(name: "PeekabooAutomationKit", package: "Peekaboo"),
            ],
            exclude: [
                "Resources/Info.plist",
            ],
            resources: [
                .copy("Resources/SmartAgentNeo.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "SmartAgentNeoMacCLI",
            dependencies: [
                "SmartAgentNeoDiscovery",
                .product(name: "SmartAgentNeoKit", package: "SmartAgentNeoKit"),
                .product(name: "SmartAgentNeoProtocol", package: "SmartAgentNeoKit"),
            ],
            path: "Sources/SmartAgentNeoMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "SmartAgentNeoIPCTests",
            dependencies: [
                "SmartAgentNeoIPC",
                "SmartAgentNeo",
                "SmartAgentNeoDiscovery",
                .product(name: "SmartAgentNeoProtocol", package: "SmartAgentNeoKit"),
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
