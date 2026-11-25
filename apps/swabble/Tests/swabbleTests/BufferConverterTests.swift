import AVFoundation
import XCTest
@testable import Swabble

final class BufferConverterTests: XCTestCase {
    func testInputFormatChangeUsesNewConversionRatio() throws {
        let target = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1))
        let converter = BufferConverter()
        _ = try converter.convert(self.buffer(sampleRate: 24000), to: target)

        let input = try self.buffer(sampleRate: 48000)
        let expected = try BufferConverter().convert(input, to: target)
        let converted = try converter.convert(input, to: target)

        XCTAssertGreaterThan(expected.frameLength, 0)
        XCTAssertEqual(converted.format, target)
        XCTAssertEqual(converted.frameLength, expected.frameLength)
    }

    private func buffer(sampleRate: Double) throws -> AVAudioPCMBuffer {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800))
        buffer.frameLength = buffer.frameCapacity
        let samples = try XCTUnwrap(buffer.floatChannelData)
        samples[0].initialize(repeating: 0.25, count: Int(buffer.frameLength))
        return buffer
    }
}
