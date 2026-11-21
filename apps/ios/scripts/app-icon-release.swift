import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// The SVG owns foreground placement. Default icons keep an opaque, full-bleed
// white background; Dark keeps transparency for the system's appearance.
let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
guard
    let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
else {
    fatalError("Cannot read the rendered app icon")
}

for argument in CommandLine.arguments.dropFirst(3) {
    guard let size = Int(argument), size > 0 else {
        fatalError("Invalid icon size: \(argument)")
    }
    guard let context = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: size * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else {
        fatalError("Cannot create the app icon context")
    }
    let bounds = CGRect(x: 0, y: 0, width: size, height: size)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(bounds)
    context.interpolationQuality = .high
    context.draw(image, in: bounds)
    let destinationURL = outputURL.appendingPathComponent("\(size).png")
    guard
        let output = context.makeImage(),
        let destination = CGImageDestinationCreateWithURL(
            destinationURL as CFURL, UTType.png.identifier as CFString, 1, nil)
    else {
        fatalError("Cannot create \(destinationURL.path)")
    }
    CGImageDestinationAddImage(destination, output, nil)
    guard CGImageDestinationFinalize(destination) else {
        fatalError("Cannot write \(destinationURL.path)")
    }
}
