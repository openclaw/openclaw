// swift-tools-version: 6.2
// Package manifest for the Mullusi macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "Mullusi",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "MullusiIPC", targets: ["MullusiIPC"]),
        .library(name: "MullusiDiscovery", targets: ["MullusiDiscovery"]),
        .executable(name: "Mullusi", targets: ["Mullusi"]),
        .executable(name: "mullusi-mac", targets: ["MullusiMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.4.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.10.1"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.0"),
        .package(url: "https://github.com/steipete/Peekaboo.git", branch: "main"),
        .package(path: "../shared/MullusiKit"),
        .package(path: "../../Swabble"),
    ],
    targets: [
        .target(
            name: "MullusiIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "MullusiDiscovery",
            dependencies: [
                .product(name: "MullusiKit", package: "MullusiKit"),
            ],
            path: "Sources/MullusiDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "Mullusi",
            dependencies: [
                "MullusiIPC",
                "MullusiDiscovery",
                .product(name: "MullusiKit", package: "MullusiKit"),
                .product(name: "MullusiChatUI", package: "MullusiKit"),
                .product(name: "MullusiProtocol", package: "MullusiKit"),
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
                .copy("Resources/Mullusi.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "MullusiMacCLI",
            dependencies: [
                "MullusiDiscovery",
                .product(name: "MullusiKit", package: "MullusiKit"),
                .product(name: "MullusiProtocol", package: "MullusiKit"),
            ],
            path: "Sources/MullusiMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "MullusiIPCTests",
            dependencies: [
                "MullusiIPC",
                "Mullusi",
                "MullusiDiscovery",
                .product(name: "MullusiProtocol", package: "MullusiKit"),
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
