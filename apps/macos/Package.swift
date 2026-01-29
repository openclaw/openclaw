// swift-tools-version: 6.2
// Package manifest for the DNA macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "DNA",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "DNAIPC", targets: ["DNAIPC"]),
        .library(name: "DNADiscovery", targets: ["DNADiscovery"]),
        .executable(name: "DNA", targets: ["DNA"]),
        .executable(name: "dna-mac", targets: ["DNAMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.8.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(url: "https://github.com/steipete/Peekaboo.git", branch: "main"),
        .package(path: "../shared/DNAKit"),
        .package(path: "../../Swabble"),
    ],
    targets: [
        .target(
            name: "DNAIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "DNADiscovery",
            dependencies: [
                .product(name: "DNAKit", package: "DNAKit"),
            ],
            path: "Sources/DNADiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "DNA",
            dependencies: [
                "DNAIPC",
                "DNADiscovery",
                .product(name: "DNAKit", package: "DNAKit"),
                .product(name: "DNAChatUI", package: "DNAKit"),
                .product(name: "DNAProtocol", package: "DNAKit"),
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
                .copy("Resources/DNA.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "DNAMacCLI",
            dependencies: [
                "DNADiscovery",
                .product(name: "DNAKit", package: "DNAKit"),
                .product(name: "DNAProtocol", package: "DNAKit"),
            ],
            path: "Sources/DNAMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "DNAIPCTests",
            dependencies: [
                "DNAIPC",
                "DNA",
                "DNADiscovery",
                .product(name: "DNAProtocol", package: "DNAKit"),
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
