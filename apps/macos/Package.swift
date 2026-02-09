// swift-tools-version: 6.2
// Package manifest for the EasyHub macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "EasyHub",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "EasyHubIPC", targets: ["EasyHubIPC"]),
        .library(name: "EasyHubDiscovery", targets: ["EasyHubDiscovery"]),
        .executable(name: "EasyHub", targets: ["EasyHub"]),
        .executable(name: "EasyHub-mac", targets: ["EasyHubMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.8.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(url: "https://github.com/steipete/Peekaboo.git", branch: "main"),
        .package(path: "../shared/EasyHubKit"),
        .package(path: "../../Swabble"),
    ],
    targets: [
        .target(
            name: "EasyHubIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "EasyHubDiscovery",
            dependencies: [
                .product(name: "EasyHubKit", package: "EasyHubKit"),
            ],
            path: "Sources/EasyHubDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "EasyHub",
            dependencies: [
                "EasyHubIPC",
                "EasyHubDiscovery",
                .product(name: "EasyHubKit", package: "EasyHubKit"),
                .product(name: "EasyHubChatUI", package: "EasyHubKit"),
                .product(name: "EasyHubProtocol", package: "EasyHubKit"),
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
                .copy("Resources/EasyHub.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "EasyHubMacCLI",
            dependencies: [
                "EasyHubDiscovery",
                .product(name: "EasyHubKit", package: "EasyHubKit"),
                .product(name: "EasyHubProtocol", package: "EasyHubKit"),
            ],
            path: "Sources/EasyHubMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "EasyHubIPCTests",
            dependencies: [
                "EasyHubIPC",
                "EasyHub",
                "EasyHubDiscovery",
                .product(name: "EasyHubProtocol", package: "EasyHubKit"),
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
