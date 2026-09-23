import Foundation
import ImageIO

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2 else { exit(EXIT_FAILURE) }
let output = URL(fileURLWithPath: arguments[0], isDirectory: true)
let inputs = arguments.dropFirst().map { URL(fileURLWithPath: $0) }
guard Set(inputs.map(\.lastPathComponent)).count == inputs.count,
      !FileManager.default.fileExists(atPath: output.path)
else { exit(EXIT_FAILURE) }
try FileManager.default.createDirectory(
    at: output, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])

// Decode only bounded, complete PNGs. Header dimensions alone can certify a
// truncated file, and ImageIO otherwise defers decoding until display time.
for url in inputs {
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true,
          let size = values.fileSize, size > 0, size <= 8 * 1024 * 1024
    else { exit(EXIT_FAILURE) }
    let data = try Data(contentsOf: url)
    // PNG requires the zero-length IEND trailer. ImageIO can successfully
    // decode pixels even when that trailer was truncated from the file.
    guard data.suffix(12).elementsEqual([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]),
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          CGImageSourceGetType(source) as String? == "public.png",
          CGImageSourceGetCount(source) == 1,
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
          let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
          let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
          (1...4096).contains(width), (1...4096).contains(height),
          let image = CGImageSourceCreateImageAtIndex(
              source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
          image.width == width, image.height == height,
          CGImageSourceGetStatus(source) == .statusComplete,
          CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete
    else { exit(EXIT_FAILURE) }
    // A decoder can ignore source metadata and bytes after IEND. Publish a
    // lossless encoding of the decoded image, never the original container.
    let encoded = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(encoded, "public.png" as CFString, 1, nil)
    else { exit(EXIT_FAILURE) }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination), encoded.length > 0, encoded.length <= 8 * 1024 * 1024
    else { exit(EXIT_FAILURE) }
    try (encoded as Data).write(to: output.appendingPathComponent(url.lastPathComponent), options: .withoutOverwriting)
}
