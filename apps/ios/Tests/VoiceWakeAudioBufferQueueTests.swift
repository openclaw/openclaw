import AVFAudio
import Testing
@testable import OpenClaw

struct VoiceWakeAudioBufferQueueTests {
    @Test(arguments: [false, true])
    func `queued audio preserves every channel after source reuse`(interleaved: Bool) throws {
        let format = try #require(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 48000,
            channels: 2,
            interleaved: interleaved))
        let source = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8))
        source.frameLength = 4
        let sourceChannels = try #require(source.floatChannelData)
        for channel in 0..<2 {
            for frame in 0..<4 {
                sourceChannels[channel][frame * source.stride] = Float(channel * 10 + frame)
            }
        }

        let queue = VoiceWakeAudioBufferQueue()
        queue.enqueueCopy(of: source)
        for channel in 0..<2 {
            for frame in 0..<4 {
                sourceChannels[channel][frame * source.stride] = -1
            }
        }

        let drained = queue.drain()
        #expect(drained.count == 1)
        let copy = try #require(drained.first)
        let copiedChannels = try #require(copy.floatChannelData)
        #expect(copy.frameLength == 4)
        #expect(copy.format == format)
        #expect((0..<4).map { copiedChannels[0][$0 * copy.stride] } == [0, 1, 2, 3])
        #expect((0..<4).map { copiedChannels[1][$0 * copy.stride] } == [10, 11, 12, 13])
        #expect(queue.drain().isEmpty)
    }
}
