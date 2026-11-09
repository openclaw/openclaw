import Foundation
import Testing
@testable import OpenClaw

private enum ClipProbeError: Error {
    case exportFailed
}

struct CameraClipCleanupTests {
    @Test(arguments: [true, false])
    func clipOwnsFilesUntilSuccessfulReturn(exportFails: Bool) async throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-clip-cleanup-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        // Also removes the expected RED's leaked partial file.
        defer { try? FileManager().removeItem(at: root) }
        let movie = Data("synthetic mov".utf8)
        let mp4 = Data("synthetic mp4".utf8)

        do {
            let result = try await CameraCaptureService().clip(
                facing: .front, durationMs: 750, includeAudio: false, deviceId: nil,
                captureMovie: { options, inputURL, _ in
                    #expect(options.preferFrontCamera)
                    #expect(options.durationMs == 750)
                    #expect(!options.includeAudio)
                    try movie.write(to: inputURL)
                    return inputURL
                },
                exportToMP4: { inputURL, outputURL in
                    #expect(try Data(contentsOf: inputURL) == movie)
                    // Simulate an exporter which has already created partial output.
                    try mp4.write(to: outputURL)
                    if exportFails { throw ClipProbeError.exportFailed }
                },
                temporaryDirectory: root)
            #expect(!exportFails)
            #expect(result.durationMs == 750)
            #expect(!result.hasAudio)
            #expect(try Data(contentsOf: URL(fileURLWithPath: result.path)) == mp4)
            let files = try FileManager().contentsOfDirectory(atPath: root.path)
            #expect(files == [URL(fileURLWithPath: result.path).lastPathComponent])
        } catch ClipProbeError.exportFailed {
            #expect(exportFails)
            // Neither the intermediate MOV nor the unreturned MP4 belongs to the caller.
            #expect(try FileManager().contentsOfDirectory(atPath: root.path).isEmpty)
        }
    }
}
