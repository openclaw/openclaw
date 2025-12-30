import XCTest
@testable import ClawdisKit

final class PCMStreamingAudioPlayerTests: XCTestCase {
    @MainActor
    func testStopDuringPCMStreamReturnsInterruptedResult() async {
        var continuation: AsyncThrowingStream<Data, Error>.Continuation?
        let stream = AsyncThrowingStream<Data, Error> { cont in
            continuation = cont
            let samples = Data(repeating: 0, count: 44_100)
            cont.yield(samples)
        }

        let task = Task { @MainActor in
            await PCMStreamingAudioPlayer.shared.play(stream: stream, sampleRate: 44_100)
        }

        try? await Task.sleep(nanoseconds: 120_000_000)
        let interruptedAt = PCMStreamingAudioPlayer.shared.stop()
        continuation?.finish()

        let result = await task.value
        XCTAssertFalse(result.finished)
        XCTAssertNotNil(interruptedAt)
    }
}
