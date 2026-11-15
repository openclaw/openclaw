// swift-tools-version: 6.3

import PackageDescription

/// Build scripts/build-apple.sh first. The binary is intentionally not checked in;
/// a missing artifact is a build prerequisite, never a transport fallback.
let package = Package(
    name: "OpenClawIroh",
    platforms: [.macOS(.v15), .iOS(.v18)],
    products: [
        .library(name: "OpenClawIroh", targets: ["OpenClawIroh"]),
    ],
    targets: [
        .binaryTarget(
            name: "OpenClawIrohFFI",
            path: "dist/apple/OpenClawIrohFFI.xcframework"),
        .target(
            name: "OpenClawIroh",
            dependencies: ["OpenClawIrohFFI"],
            path: "generated",
            exclude: ["ai", "OpenClawIrohFFI.h", "OpenClawIrohFFI.modulemap"],
            sources: ["OpenClawIroh.swift"],
            linkerSettings: [
                .linkedFramework("Security"),
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("Network"),
                .linkedFramework("CoreWLAN", .when(platforms: [.macOS])),
            ]),
        .testTarget(
            name: "OpenClawIrohTests",
            dependencies: ["OpenClawIroh"],
            path: "swift-tests"),
    ])
