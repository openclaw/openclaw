// swift-tools-version: 6.3

import Foundation
import PackageDescription

// Native transport is an explicit build opt-in; ordinary app builds need no XCFramework.
let nativeIrohEnabled = ProcessInfo.processInfo.environment["OPENCLAW_IROH_NATIVE"] == "1"
let nativePackages: [Package.Dependency] = nativeIrohEnabled
    ? [.package(path: "../../../crates/openclaw-iroh-ffi")] : []
let nativeDependencies: [Target.Dependency] = nativeIrohEnabled
    ? [.product(name: "OpenClawIroh", package: "openclaw-iroh-ffi",
                condition: .when(platforms: [.iOS, .macOS]))] : []
let nativeSettings: [SwiftSetting] = nativeIrohEnabled
    ? [.define("OPENCLAW_IROH_NATIVE", .when(platforms: [.iOS, .macOS]))] : []

let package = Package(
    name: "OpenClawKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
        .watchOS(.v11),
    ],
    products: [
        .library(name: "OpenClawProtocol", targets: ["OpenClawProtocol"]),
        .library(name: "OpenClawNativeState", targets: ["OpenClawNativeState"]),
        .library(name: "OpenClawKit", targets: ["OpenClawKit"]),
        .library(name: "OpenClawChatUI", targets: ["OpenClawChatUI"]),
    ],
    traits: [
        .trait(name: "Talk", description: "ElevenLabs cloud TTS / talk support"),
        .default(enabledTraits: ["Talk"]),
    ],
    dependencies: nativePackages + [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.3"),
        .package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.11.1"),
        .package(url: "https://github.com/mgriebling/SwiftMath", exact: "1.7.3"),
        .package(url: "https://github.com/swiftlang/swift-markdown", exact: "0.9.0"),
    ],
    targets: [
        .target(
            name: "OpenClawProtocol",
            path: "Sources/OpenClawProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ],
            plugins: ["GenerateGatewayProtocol"]),
        .plugin(
            name: "GenerateGatewayProtocol",
            capability: .buildTool()),
        .target(
            name: "OpenClawNativeState",
            path: "Sources/OpenClawNativeState",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "OpenClawKit",
            dependencies: nativeDependencies + [
                "OpenClawNativeState",
                "OpenClawProtocol",
                .product(
                    name: "ElevenLabsKit",
                    package: "ElevenLabsKit",
                    condition: .when(platforms: [.iOS, .macOS], traits: ["Talk"])),
            ],
            path: "Sources/OpenClawKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: nativeSettings + [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "OpenClawChatUI",
            dependencies: [
                "OpenClawKit",
                "OpenClawProtocol",
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "Markdown", package: "swift-markdown"),
                .product(name: "SwiftMath", package: "SwiftMath"),
            ],
            path: "Sources/OpenClawChatUI",
            resources: [
                .copy("Resources/Mermaid"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "OpenClawKitTests",
            dependencies: nativeDependencies + [
                "OpenClawKit",
                "OpenClawChatUI",
                "OpenClawProtocol",
                .product(name: "GRDB", package: "GRDB.swift"),
            ],
            path: "Tests/OpenClawKitTests",
            resources: [.copy("Fixtures")],
            swiftSettings: nativeSettings + [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
        .testTarget(
            name: "OpenClawNativeStateTests",
            dependencies: ["OpenClawNativeState"],
            path: "Tests/OpenClawNativeStateTests",
            resources: [.copy("Fixtures")],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
