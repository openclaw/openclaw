// swift-tools-version: 5.4
// The swift-tools-version declares the minimum version of Swift required to build this package.
import PackageDescription

let package = Package(
    name: "ESPProvision",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        // Products define the executables and libraries a package produces, and make them visible to other packages.
        .library(
            name: "ESPProvision",
            targets: ["ESPProvision"]),
    ],
    dependencies: [
        .package(
            name: "SwiftProtobuf",
            url: "https://github.com/apple/swift-protobuf.git",
            .exact("1.39.0")
        )
    ],
    targets: [
        // Targets are the basic building blocks of a package. A target can define a module or a test suite.
        // Targets can depend on other targets in this package, and on products in packages this package depends on.
        .target(
            name: "ESPProvision",
            dependencies: ["SwiftProtobuf"],
            path: "ESPProvision",
            exclude: ["Example","Tests","Pods"]
        ),
        .testTarget(name: "ESPProvisionTests", dependencies: ["ESPProvision"]),
    ]
)
