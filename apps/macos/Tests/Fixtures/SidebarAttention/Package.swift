// swift-tools-version: 6.3
import PackageDescription

let package = Package(
    name: "SidebarAttentionFixture",
    platforms: [.macOS(.v15)],
    dependencies: [.package(path: "../../../../shared/OpenClawKit")],
    targets: [.executableTarget(
        name: "SidebarAttentionFixture",
        dependencies: [.product(name: "OpenClawChatUI", package: "OpenClawKit")],
        path: ".",
        exclude: ["README.md"],
        sources: ["Fixture.swift"])])
