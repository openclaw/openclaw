// Reads the text on simulator or device screenshots, for `pnpm ios:behavior`.
// Prints one JSON line per image: {"image": path, "lines": [{"text", "x", "y", "w", "h"}]}, with
// boxes normalized to the image and the origin at the top left. The harness decides which part of
// the screen is the transcript; this only reports what is drawn, independent of the view tree.
// Accurate recognition: the fast level misses text on the gray assistant bubbles.
import AppKit
import Foundation
import Vision

for path in CommandLine.arguments.dropFirst() {
    var lines: [[String: Any]] = []
    if let image = NSImage(contentsOfFile: path),
       let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try? VNImageRequestHandler(cgImage: cgImage).perform([request])
        for observation in request.results ?? [] {
            guard let text = observation.topCandidates(1).first?.string else { continue }
            let box = observation.boundingBox
            lines.append([
                "text": text,
                "x": box.minX,
                "y": 1 - box.maxY,
                "w": box.width,
                "h": box.height,
            ])
        }
    }
    let record: [String: Any] = ["image": path, "lines": lines]
    if let data = try? JSONSerialization.data(withJSONObject: record) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
