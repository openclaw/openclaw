// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "FaceTimeAudioCapture",
  platforms: [.macOS("14.4")],
  products: [
    .executable(name: "facetime-audio-capture", targets: ["FaceTimeAudioCapture"])
  ],
  targets: [
    .executableTarget(
      name: "FaceTimeAudioCapture",
      exclude: ["Info.plist"],
      linkerSettings: [
        .unsafeFlags([
          "-Xlinker", "-sectcreate",
          "-Xlinker", "__TEXT",
          "-Xlinker", "__info_plist",
          "-Xlinker", "Sources/FaceTimeAudioCapture/Info.plist",
        ])
      ])
  ])
