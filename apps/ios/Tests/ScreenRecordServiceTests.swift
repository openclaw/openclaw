import Foundation
import Testing
@testable import OpenClaw

private final class ScreenRecordServiceProbe: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var startCount = 0
    private(set) var stopCount = 0

    func recordStart() {
        self.lock.lock()
        self.startCount += 1
        self.lock.unlock()
    }

    func recordStop() {
        self.lock.lock()
        self.stopCount += 1
        self.lock.unlock()
    }
}

@Suite(.serialized) struct ScreenRecordServiceTests {
    @Test func clampDefaultsAndBounds() {
        #expect(ScreenRecordService._test_clampDurationMs(nil) == 10000)
        #expect(ScreenRecordService._test_clampDurationMs(0) == 250)
        #expect(ScreenRecordService._test_clampDurationMs(60001) == 60000)

        #expect(ScreenRecordService._test_clampFps(nil) == 10)
        #expect(ScreenRecordService._test_clampFps(0) == 1)
        #expect(ScreenRecordService._test_clampFps(120) == 30)
        #expect(ScreenRecordService._test_clampFps(.infinity) == 10)
    }

    @Test @MainActor func recordRejectsInvalidScreenIndex() async {
        let recorder = ScreenRecordService()
        do {
            _ = try await recorder.record(
                screenIndex: 1,
                durationMs: 250,
                fps: 5,
                includeAudio: false,
                outPath: nil)
            Issue.record("Expected invalid screen index to throw")
        } catch let error as ScreenRecordService.ScreenRecordError {
            #expect(error.localizedDescription.contains("Invalid screen index") == true)
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
    }

    @Test func recordStopsCaptureWhenSleepIsCancelled() async {
        let probe = ScreenRecordServiceProbe()
        let recorder = ScreenRecordService(
            startReplayKitCaptureAction: { _, _, completion in
                probe.recordStart()
                completion(nil)
            },
            stopReplayKitCaptureAction: { completion in
                probe.recordStop()
                completion(nil)
            },
            sleepNanoseconds: { _ in
                throw CancellationError()
            })

        do {
            _ = try await recorder.record(
                screenIndex: nil,
                durationMs: 250,
                fps: 5,
                includeAudio: false,
                outPath: nil)
            Issue.record("Expected cancellation to throw")
        } catch is CancellationError {
            // Expected; cleanup should stop ReplayKit before preserving cancellation.
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }

        #expect(probe.startCount == 1)
        #expect(probe.stopCount == 1)
    }
}
