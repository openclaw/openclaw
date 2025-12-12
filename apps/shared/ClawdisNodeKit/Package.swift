// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "ClawdisNodeKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v15),
    ],
    products: [
        .library(name: "ClawdisNodeKit", targets: ["ClawdisNodeKit"]),
    ],
    targets: [
        .target(
            name: "ClawdisNodeKit",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
    ])

