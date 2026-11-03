import AppKit
import CryptoKit
import Foundation
import SwiftUI

struct ProbeFailure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { self.errorDescription = message }
}
func require(_ value: Bool, _ message: String) throws {
    if !value { throw ProbeFailure(message) }
}
func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func rect(_ value: NSRect) -> [String: Double] {
    ["x": Double(value.minX), "y": Double(value.minY), "width": Double(value.width), "height": Double(value.height)]
}

struct ProbeCase {
    let id: String
    let loader: String
    let paint: Bool
    let button: Bool
    let canvas: Bool
    let halfPhase: Bool
    let role: String
}

@MainActor
@main
struct ReferenceDiagnostic {
    static func main() throws {
        try require(CommandLine.arguments.count == 3, "ReferenceDiagnostic INPUT_DIR OUTPUT_DIR")
        let input = URL(fileURLWithPath: CommandLine.arguments[1])
        let output = URL(fileURLWithPath: CommandLine.arguments[2])
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let app = NSApplication.shared
        try require(app.setActivationPolicy(.accessory), "Accessory activation policy unavailable")
        app.finishLaunching()
        let manifestData = try Data(contentsOf: input.appendingPathComponent("diagnostic-plan.json"))
        guard let plan = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              let assets = plan["assets"] as? [String: [String: String]],
              let sceneData = try JSONSerialization.jsonObject(with: Data(contentsOf: input.appendingPathComponent("scenes.json"))) as? [String: Any],
              let scenes = sceneData["scenes"] as? [[String: Any]],
              let choices = scenes.first?["choices"] as? [[String: Any]]
        else { throw ProbeFailure("Invalid sealed plan/scene schema") }
        let cases = [
            ProbeCase(id: "old-data-white-small", loader: "data", paint: false, button: false, canvas: false, halfPhase: false, role: "baseline-reproduction"),
            ProbeCase(id: "data-white-small-source-order", loader: "data", paint: false, button: false, canvas: false, halfPhase: false, role: "modifier-wrapper-control"),
            ProbeCase(id: "data-white-canvas", loader: "data", paint: false, button: false, canvas: true, halfPhase: false, role: "host-extent-control"),
            ProbeCase(id: "data-source-paint", loader: "data", paint: true, button: false, canvas: true, halfPhase: false, role: "background-control"),
            ProbeCase(id: "file-source-paint", loader: "file", paint: true, button: false, canvas: true, halfPhase: false, role: "minimal-candidate"),
            ProbeCase(id: "file-source-button", loader: "file", paint: true, button: true, canvas: true, halfPhase: false, role: "full-source-context-control"),
            ProbeCase(id: "file-source-half-phase", loader: "file", paint: true, button: true, canvas: true, halfPhase: true, role: "sensitivity-only-not-a-repair"),
        ]
        var records: [[String: Any]] = []
        for choice in choices {
            guard let brand = choice["brand"] as? String,
                  let asset = assets[brand], let filename = asset["filename"], let expected = asset["sha256"],
                  let origin = choice["wellPixelOrigin"] as? [Double], origin.count == 2,
                  let row = choice["rowScreenRect"] as? [String: Double],
                  let label = choice["label"] as? String, let hint = choice["hint"] as? String,
                  let action = choice["action"] as? String
            else { throw ProbeFailure("Missing sealed choice") }
            let url = input.appendingPathComponent("assets/\(filename)")
            for probe in cases {
                // Fresh verified object per case, independent of the production resolver/cache.
                let image = try SourceReferenceProducer.image(url: url, expectedSha256: expected, loader: probe.loader)
                let nominal = image.size
                let phase: CGFloat = probe.halfPhase ? 0.5 : 0
                let wellOrigin = CGPoint(x: CGFloat(origin[0]) + phase, y: CGFloat(origin[1]) + phase)
                let content = SourceReferenceProducer.well(image: image, sourcePaint: probe.paint)
                let tile: AnyView
                if probe.button {
                    tile = AnyView(Button {} label: {
                        HStack(spacing: 10) {
                            content
                            VStack(alignment: .leading, spacing: 2) {
                                Text(label).font(.callout.weight(.semibold))
                                Text(hint).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            Text(action).font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 8)
                        .frame(width: CGFloat(row["width"] ?? 538), alignment: .leading)
                    }.buttonStyle(.plain))
                } else { tile = AnyView(content) }
                let width: CGFloat = probe.canvas ? 630 : 32
                let height: CGFloat = probe.canvas ? 1000 : 32
                let cropOrigin = probe.canvas ? CGPoint(x: CGFloat(origin[0]), y: CGFloat(origin[1])) : .zero
                let tileOrigin = probe.canvas
                    ? CGPoint(x: wellOrigin.x - (probe.button ? 10 : 0), y: wellOrigin.y - (probe.button ? 8 : 0))
                    : .zero
                let root: AnyView
                if probe.id == "old-data-white-small" {
                    // Literal old producer expression, not a new wrapper approximation.
                    root = AnyView(Image(nsImage: image).renderingMode(.template).resizable().scaledToFit()
                        .frame(width: 18, height: 18).foregroundStyle(.primary)
                        .frame(width: 32, height: 32).background(Color.white))
                } else {
                    root = AnyView(ZStack(alignment: .topLeading) {
                        Color.white
                        tile.background(probe.paint ? Color.primary.opacity(0.045) : Color.clear)
                            .offset(x: tileOrigin.x, y: tileOrigin.y)
                    }.frame(width: width, height: height, alignment: .topLeading))
                }
                let folder = output.appendingPathComponent("\(brand)/\(probe.id)")
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let result = try capture(root, width: width, height: height, cropOrigin: cropOrigin,
                    file: folder, image: image, nominal: nominal, phase: phase)
                records.append(["brand": brand, "case": probe.id, "role": probe.role, "loader": probe.loader,
                    "sourcePaint": probe.paint, "plainButtonContext": probe.button, "requestedHalfPhase": probe.halfPhase,
                    "assetSha256": expected, "wellOriginOnReferenceCanvas": [Double(cropOrigin.x), Double(cropOrigin.y)],
                    "result": result])
            }
        }
        // A generic fallback is a source-defined negative, never a candidate asset.
        let arrow = AnyView(ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.06))
            Image(systemName: "arrow.down.circle").font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary).frame(width: 18, height: 18)
        }.frame(width: 32, height: 32).background(Color.primary.opacity(0.045)).background(Color.white))
        let arrowFolder = output.appendingPathComponent("fallback")
        try FileManager.default.createDirectory(at: arrowFolder, withIntermediateDirectories: true)
        let arrowResult = try capture(arrow, width: 32, height: 32, cropOrigin: .zero,
            file: arrowFolder, image: nil, nominal: .zero, phase: 0)
        let actual = try retainedColorObservations(input: input, output: output, scenes: scenes, sourceMembers: plan["retainedMembers"] as? [String: String] ?? [:])
        let metadata: [String: Any] = ["actualColorObservations": actual, "status": "REFERENCE_DIAGNOSTIC_ONLY_ORIGINAL_QUALIFICATION_STILL_FAILED",
            "planSha256": sha(manifestData), "records": records, "fallback": arrowResult,
            "deviceRGB": colorSpace(NSColorSpace.deviceRGB), "sRGB": colorSpace(NSColorSpace.sRGB),
            "labelColorDeviceRGB": components(NSColor.labelColor, space: .deviceRGB),
            "labelColorSRGB": components(NSColor.labelColor, space: .sRGB),
            "appActivationPolicy": app.activationPolicy().rawValue, "appActive": app.isActive]
        try JSONSerialization.data(withJSONObject: metadata, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("reference-index.json"))
    }

    static func retainedColorObservations(input: URL, output: URL, scenes: [[String: Any]], sourceMembers: [String: String]) throws -> [[String: Any]] {
        var records: [[String: Any]] = []
        for scene in scenes {
            guard let stage = scene["stage"] as? String, ["before", "after"].contains(stage),
                  let sourceHash = sourceMembers[stage + "/onboarding.png"],
                  let choices = scene["choices"] as? [[String: Any]] else { throw ProbeFailure("Bad retained scene") }
            for choice in choices {
                guard let brand = choice["brand"] as? String else { throw ProbeFailure("Bad well") }
                let data = try Data(contentsOf: input.appendingPathComponent("retained/roi-\(brand).png"))
                guard let bitmap = NSBitmapImageRep(data: data) else { throw ProbeFailure("Cannot decode derived ROI PNG") }
                try require(bitmap.pixelsWide == 34 && bitmap.pixelsHigh == 34, "Derived ROI changed")
                let folder = output.appendingPathComponent("retained-colors/\(stage)/\(brand)")
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                var device = Data(); var srgb = Data()
                for y in 0..<34 { for x in 0..<34 {
                    guard let color = bitmap.colorAt(x: x, y: y) else { throw ProbeFailure("Derived ROI pixel unavailable") }
                    let d = components(color, space: .deviceRGB); let s = components(color, space: .sRGB)
                    try require(d.count == 4 && s.count == 4, "ROI conversion unavailable")
                    for value in d { var bits = value.bitPattern.littleEndian; withUnsafeBytes(of: &bits) { device.append(contentsOf: $0) } }
                    for value in s { var bits = value.bitPattern.littleEndian; withUnsafeBytes(of: &bits) { srgb.append(contentsOf: $0) } }
                } }
                try device.write(to: folder.appendingPathComponent("deviceRGB.f64le"))
                try srgb.write(to: folder.appendingPathComponent("sRGB.f64le"))
                records.append(["stage": stage, "brand": brand, "rgbaWidth": 34, "rgbaHeight": 34, "margin": 1,
                    "inputKind": "DERIVED_ROI_NOT_ORIGINAL_FULL_PNG", "sourceOriginalPngSha256": sourceHash,
                    "derivedRoiPngSha256": sha(data), "wholeImageRepresentationOrCacheEquivalenceClaimed": false,
                    "bitmapColorSpace": colorSpace(bitmap.colorSpace), "deviceRGBSha256": sha(device), "sRGBSha256": sha(srgb)])
            }
        }
        return records
    }

    static func colorSpace(_ space: NSColorSpace?) -> [String: Any] {
        guard let space else { return ["available": false] }
        return ["available": true, "name": space.localizedName ?? "unknown",
            "model": String(describing: space.colorSpaceModel),
            "iccProfileAvailable": space.iccProfileData != nil, "iccSha256": space.iccProfileData.map(sha) ?? ""]
    }
    static func components(_ color: NSColor, space: NSColorSpace) -> [Double] {
        guard let c = color.usingColorSpace(space) else { return [] }
        return [Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent), Double(c.alphaComponent)]
    }
    static func capture(_ content: AnyView, width: CGFloat, height: CGFloat, cropOrigin: CGPoint,
                        file: URL, image: NSImage?, nominal: NSSize, phase: CGFloat) throws -> [String: Any] {
        let hosting = NSHostingView(rootView: content.environment(\.locale, Locale(identifier: "en_US"))
            .environment(\.colorScheme, .light))
        hosting.appearance = NSAppearance(named: .aqua)
        hosting.frame = NSRect(x: 0, y: 0, width: width, height: height)
        let window = NSWindow(contentRect: hosting.frame, styleMask: width == 32 ? [.borderless] : [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = hosting
        defer { window.orderOut(nil); window.contentView = nil; window.close() }
        window.orderFront(nil); hosting.layoutSubtreeIfNeeded(); window.displayIfNeeded()
        try require(hosting.bounds.size == NSSize(width: width, height: height), "Unexpected reference bounds")
        try require(window.backingScaleFactor == 1, "Retained scene requires scale1; no scale substitution")
        var passes: [[String: Any]] = []
        for pass in ["first", "warm-repeat"] {
            guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { throw ProbeFailure("No reference bitmap") }
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            // Measure the original colorAt path before asking the bitmap to encode PNG.
            var device = Data(); var srgb = Data(); var maskRows: [String] = []
            for y in 0..<32 {
                var row = ""
                for x in 0..<32 {
                    guard let c = bitmap.colorAt(x: Int(cropOrigin.x) + x, y: Int(cropOrigin.y) + y) else { throw ProbeFailure("Missing pixel") }
                    let d = components(c, space: .deviceRGB); let s = components(c, space: .sRGB)
                    try require(d.count == 4 && s.count == 4, "RGBA conversion unavailable")
                    for value in d { var bits = value.bitPattern.littleEndian; withUnsafeBytes(of: &bits) { device.append(contentsOf: $0) } }
                    for value in s { var bits = value.bitPattern.littleEndian; withUnsafeBytes(of: &bits) { srgb.append(contentsOf: $0) } }
                    row += d[3] > 0.5 && d[0] * 255 < 180 && d[1] * 255 < 180 && d[2] * 255 < 180 ? "1" : "0"
                }
                maskRows.append(row)
            }
            guard let png = bitmap.representation(using: .png, properties: [:]) else { throw ProbeFailure("No PNG") }
            try png.write(to: file.appendingPathComponent("\(pass).png"))
            try device.write(to: file.appendingPathComponent("\(pass)-deviceRGB.f64le"))
            try srgb.write(to: file.appendingPathComponent("\(pass)-sRGB.f64le"))
            passes.append(["pass": pass, "pngSha256": sha(png), "nativeDeviceMask": maskRows,
                "bitmapColorSpace": colorSpace(bitmap.colorSpace), "bitmapColorSpaceName": String(describing: bitmap.colorSpaceName),
                "pixelsWide": bitmap.pixelsWide, "pixelsHigh": bitmap.pixelsHigh,
                "bitsPerSample": bitmap.bitsPerSample, "bitsPerPixel": bitmap.bitsPerPixel,
                "samplesPerPixel": bitmap.samplesPerPixel, "bytesPerRow": bitmap.bytesPerRow,
                "bitmapFormat": bitmap.bitmapFormat.rawValue])
        }
        var representations: [[String: Any]] = []
        if let image {
            try require(image.size == nominal, "Diagnostic must not resize NSImage")
            representations = image.representations.map { r in ["class": String(reflecting: type(of: r)),
                "pointWidth": Double(r.size.width), "pointHeight": Double(r.size.height), "pixelsWide": r.pixelsWide,
                "pixelsHigh": r.pixelsHigh, "bitsPerSample": r.bitsPerSample, "hasAlpha": r.hasAlpha,
                "isOpaque": r.isOpaque, "colorSpaceName": String(describing: r.colorSpaceName)] }
        }
        let glyph = NSRect(x: cropOrigin.x + 7 + phase, y: cropOrigin.y + 7 + phase, width: 18, height: 18)
        return ["passes": passes, "bounds": rect(hosting.bounds), "hostingFrame": rect(hosting.frame),
            "hostingFlipped": hosting.isFlipped, "windowFrame": rect(window.frame),
            "windowColorSpace": colorSpace(window.colorSpace), "backingScale": Double(window.backingScaleFactor),
            "glyphFrameDerivedFromSource": rect(glyph), "glyphBackingRect": rect(hosting.convertToBacking(glyph)),
            "nominalImageSize": ["width": Double(nominal.width), "height": Double(nominal.height)],
            "imageCacheMode": image.map { String(describing: $0.cacheMode) } ?? "no-image",
            "imageRepresentationsAfterBothPasses": representations]
    }
}
